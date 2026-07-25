import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { appendEvent, readEvents } from "../src/fleet/events.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fleet-events-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("appendEvent preserves every event when same-process writers overlap", async () => {
  // Given: one empty event log and many independent writers.
  const directory = await createTemporaryDirectory();
  const eventsPath = join(directory, "events.jsonl");
  const expectedIds = Array.from({ length: 100 }, (_, index) => `step-${index}`);

  // When: all writers append concurrently.
  await Promise.all(
    expectedIds.map((stepId) =>
      appendEvent(eventsPath, { runId: "run-concurrent", stepId }),
    ),
  );

  // Then: every complete event is readable exactly once.
  const events = await readEvents(eventsPath);
  assert.equal(events.length, expectedIds.length);
  assert.deepEqual(
    new Set(events.map((event) => event.stepId)),
    new Set(expectedIds),
  );
});

test("appendEvent is append-only across sequential writes", async () => {
  // Given: a log with one event.
  const directory = await createTemporaryDirectory();
  const eventsPath = join(directory, "events.jsonl");
  await appendEvent(eventsPath, { runId: "run-prefix", stepId: "first" });
  const original = await readFile(eventsPath, "utf8");

  // When: a second event is appended.
  await appendEvent(eventsPath, { runId: "run-prefix", stepId: "second" });

  // Then: the original bytes remain the log prefix.
  const updated = await readFile(eventsPath, "utf8");
  assert.ok(updated.startsWith(original));
  assert.ok(updated.length > original.length);
});

test("readEvents skips malformed lines without hiding valid events", async () => {
  // Given: valid records surrounding malformed and non-object JSON.
  const directory = await createTemporaryDirectory();
  const eventsPath = join(directory, "events.jsonl");
  await appendEvent(eventsPath, { runId: "run-tolerant", stepId: "before" });
  await appendFile(eventsPath, "{broken\nnull\n[]\n", "utf8");
  await appendEvent(eventsPath, { runId: "run-tolerant", stepId: "after" });

  // When: a reader loads the log.
  const events = await readEvents(eventsPath);

  // Then: only the valid Event objects are returned.
  assert.deepEqual(
    events.map((event) => event.stepId),
    ["before", "after"],
  );
});
