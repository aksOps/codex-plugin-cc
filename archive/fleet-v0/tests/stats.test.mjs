import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { calculateStats } from "../src/fleet/stats.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("stats split pass rates by rule, degrade state, and checkKind", () => {
  const stats = calculateStats([
    {
      eventKind: "finalization",
      rule: "ignored",
      outcome: "pass",
      durationMs: 1,
      degraded: false,
      checkKind: "command",
    },
    {
      rule: "implement-small",
      outcome: "pass",
      durationMs: 10,
      degraded: false,
      checkKind: "command",
    },
    {
      rule: "implement-small",
      outcome: "fail",
      durationMs: 30,
      degraded: true,
      checkKind: "command",
    },
    {
      rule: "refactor-cross-module",
      outcome: "unverified",
      durationMs: 20,
      degraded: false,
      checkKind: "review",
    },
  ]);

  assert.deepEqual(stats.byRule, [
    {
      key: "implement-small",
      total: 2,
      passed: 1,
      passRate: 0.5,
      medianDurationMs: 20,
    },
    {
      key: "refactor-cross-module",
      total: 1,
      passed: 0,
      passRate: 0,
      medianDurationMs: 20,
    },
  ]);
  assert.deepEqual(stats.byDegraded, [
    { key: "false", total: 2, passed: 1, passRate: 0.5 },
    { key: "true", total: 1, passed: 0, passRate: 0 },
  ]);
  assert.deepEqual(stats.byCheckKind, [
    { key: "command", total: 2, passed: 1, passRate: 0.5 },
    { key: "review", total: 1, passed: 0, passRate: 0 },
  ]);
});

test("stats CLI reads an Event log and prints the split report", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-stats-"));
  const eventsPath = path.join(directory, "events.jsonl");
  try {
    await writeFile(
      eventsPath,
      `${JSON.stringify({
        rule: "implement-small",
        outcome: "pass",
        durationMs: 12,
        degraded: false,
        checkKind: "command",
      })}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["src/cli.mjs", "stats", eventsPath],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).byCheckKind[0].key, "command");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
