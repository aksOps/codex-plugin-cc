import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startCodexQuotaMonitor } from "../src/codex/quota.mjs";

async function createFakeAppServer(root, { emitUpdated = false } = {}) {
  const scriptPath = path.join(root, "fake-codex.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === 1) {
    process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\\n");
  } else if (message.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 },
          secondary: null,
          rateLimitReachedType: null
        },
        rateLimitResetCredits: { availableCount: 2, credits: [] }
      }
    }) + "\\n");
    ${
      emitUpdated
        ? `process.stdout.write(JSON.stringify({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 15, resetsAt: 1730947200 },
          secondary: null,
          rateLimitReachedType: "primary"
        }
      }
    }) + "\\n");
`
        : ""
    }
  } else if (message.method === "account/rate_limits/read") {
    process.stdout.write(JSON.stringify({ id: message.id, error: { message: "snake_case" } }) + "\\n");
  }
}
`,
    { mode: 0o700 },
  );
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

test("Codex quota monitor seeds camelCase limits and caches reset credits", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-quota-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root);

  // When
  const monitor = await startCodexQuotaMonitor({
    repoRoot,
    codexHome,
    codexPath,
  });

  // Then
  try {
    assert.deepEqual(monitor.getSnapshot(), {
      capturedAt: monitor.getSnapshot().capturedAt,
      codexAvailable: true,
      codexFloor: 85,
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 },
        secondary: null,
        rateLimitReachedType: null,
      },
      resetCredits: { availableCount: 2 },
    });
    assert.match(monitor.getSnapshot().capturedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(repoRoot, ".fleet", "quota.json"), "utf8"),
      ),
      monitor.getSnapshot(),
    );
  } finally {
    await monitor.close();
  }
});

test("Codex quota floor degrades before an exact reached-limit signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-quota-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root);
  const monitor = await startCodexQuotaMonitor({
    repoRoot,
    codexHome,
    codexPath,
    codexFloor: 1,
  });

  try {
    assert.equal(monitor.getSnapshot().codexAvailable, false);
    assert.equal(monitor.getSnapshot().rateLimits.rateLimitReachedType, null);
    assert.equal(monitor.getSnapshot().resetCredits.availableCount, 2);
  } finally {
    await monitor.close();
  }
});

test("Codex quota monitor hard-stops on a pushed reached limit", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-quota-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root, { emitUpdated: true });
  const monitor = await startCodexQuotaMonitor({
    repoRoot,
    codexHome,
    codexPath,
  });

  // When
  await monitor.waitForUpdate();

  // Then
  try {
    assert.equal(monitor.getSnapshot().codexAvailable, false);
    assert.equal(
      monitor.getSnapshot().rateLimits.rateLimitReachedType,
      "primary",
    );
    assert.equal(monitor.getSnapshot().resetCredits.availableCount, 2);
  } finally {
    await monitor.close();
  }
});
