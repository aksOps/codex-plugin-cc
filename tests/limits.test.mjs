import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writePolicy } from "./helpers.mjs";
import { buildIsolatedEnv, isCredentialLikeName } from "../plugins/codex/scripts/lib/env-isolation.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import {
  assertConcurrencyAvailable,
  countActiveJobs,
  resolveLimits,
  truncateOutput,
  withDeadline
} from "../plugins/codex/scripts/lib/limits.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

test("limits fall back to defaults when a policy omits them", () => {
  const limits = resolveLimits(null);
  assert.equal(limits.maxConcurrentJobs, 3);
  assert.equal(limits.network, "off");
  assert.deepEqual(limits.allowedCommands, []);
});

test("only queued and running jobs count toward concurrency", () => {
  const jobs = [
    { id: "a", status: "running" },
    { id: "b", status: "queued" },
    { id: "c", status: "completed" },
    { id: "d", status: "failed" },
    { id: "e", status: "cancelled" }
  ];
  assert.equal(countActiveJobs(jobs), 2);
});

test("concurrency beyond the policy bound is refused with an actionable message", () => {
  const policy = { limits: { maxConcurrentJobs: 2 } };
  const underLimit = [{ id: "a", status: "running" }];
  assert.deepEqual(assertConcurrencyAvailable(underLimit, policy), { active: 1, limit: 2 });

  const atLimit = [
    { id: "a", status: "running" },
    { id: "b", status: "queued" }
  ];
  assert.throws(
    () => assertConcurrencyAvailable(atLimit, policy, { hint: "check /codex:status" }),
    /already active and the policy allows 2.*check \/codex:status/s
  );
});

test("output truncation keeps the tail and marks itself", () => {
  const short = truncateOutput("hello", 1024);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "hello");

  const long = truncateOutput("x".repeat(500) + "TAIL", 200);
  assert.equal(long.truncated, true);
  assert.equal(long.originalBytes, 504);
  assert.match(long.text, /output truncated/);
  assert.match(long.text, /TAIL$/);
  assert.equal(Buffer.byteLength(long.text, "utf8") <= 200, true);
});

/**
 * Work that outlives its deadline, with a handle to settle it afterwards. A promise that never
 * settles would leave the test file's event loop with a pending resolution, which the test
 * runner reports as a cancelled file rather than a passing test.
 */
function stallingWork() {
  let release;
  let holder;
  const promise = new Promise((resolve) => {
    release = resolve;
    // A referenced timer, unlike the deadline's unref'd one, keeps the event loop alive long
    // enough for the deadline to fire. Without it the loop drains first and the runner reports
    // "Promise resolution is still pending but the event loop has already resolved".
    holder = setTimeout(resolve, 5000);
  });
  return {
    work: () => promise,
    release: () => {
      clearTimeout(holder);
      release();
    },
    settled: promise
  };
}

test("a run that exceeds its deadline rejects and terminates the process tree", async () => {
  // The terminator is injected rather than real: terminateProcessTree signals a whole process
  // group, and handing it an invented pid asks the host to signal something it does not own.
  const terminated = [];
  const stalled = stallingWork();

  await assert.rejects(
    withDeadline(stalled.work, {
      maxDurationMs: 60,
      getPid: () => 4242,
      terminate: (pid) => terminated.push(pid)
    }),
    /exceeded the policy limit of 60ms/
  );

  assert.deepEqual(terminated, [4242]);
  stalled.release();
  await stalled.settled;
});

test("a deadline with no live process terminates nothing", async () => {
  const terminated = [];

  for (const pid of [null, undefined, 0, -1, Number.NaN]) {
    const stalled = stallingWork();
    await assert.rejects(
      withDeadline(stalled.work, {
        maxDurationMs: 20,
        getPid: () => pid,
        terminate: (value) => terminated.push(value)
      }),
      /exceeded the policy limit/
    );
    stalled.release();
    await stalled.settled;
  }

  assert.deepEqual(terminated, [], "an absent or invalid pid must never be signalled");
});

test("a run that finishes before its deadline returns normally", async () => {
  const value = await withDeadline(async () => "done", { maxDurationMs: 5000 });
  assert.equal(value, "done");
});

test("credential-shaped environment names are recognized", () => {
  for (const name of [
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "MY_SERVICE_PASSWORD",
    "SSH_AUTH_SOCK",
    "NPM_CONFIG_REGISTRY"
  ]) {
    assert.equal(isCredentialLikeName(name), true, `${name} should be treated as a credential`);
  }
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "MONKEY"]) {
    assert.equal(isCredentialLikeName(name), false, `${name} should not be treated as a credential`);
  }
});

test("the isolated environment is an allowlist that policy cannot widen to credentials", () => {
  const { env, dropped } = buildIsolatedEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      GITHUB_TOKEN: "ghp_secret",
      ANTHROPIC_API_KEY: "sk-secret",
      MY_FEATURE_FLAG: "on",
      CUSTOM_ALLOWED: "yes"
    },
    { passthrough: ["CUSTOM_ALLOWED", "GITHUB_TOKEN"] }
  );

  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/dev", CUSTOM_ALLOWED: "yes" });
  assert.equal(dropped.includes("GITHUB_TOKEN"), true, "an allowlisted credential is still dropped");
  assert.equal(dropped.includes("ANTHROPIC_API_KEY"), true);
  assert.equal(dropped.includes("MY_FEATURE_FLAG"), true);
});

test("plugin-controlled values are injected after filtering", () => {
  const { env } = buildIsolatedEnv({ PATH: "/usr/bin" }, { extra: { CODEX_JOB_ID: "task-1" } });
  assert.equal(env.CODEX_JOB_ID, "task-1");
});

test("a second concurrent write job is refused when the policy allows one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["src/**"] } },
    limits: { maxConcurrentJobs: 1 }
  });

  // Seed an already-active job rather than racing a real background run, which the fake Codex
  // finishes almost immediately.
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "task-already-running",
          kind: "task",
          jobClass: "task",
          status: "running",
          title: "Codex Task",
          summary: "an earlier write job",
          createdAt: "2026-03-18T15:00:00.000Z",
          updatedAt: "2026-03-18T15:00:00.000Z"
        }
      ]
    }, null, 2)}\n`,
    "utf8"
  );

  const blocked = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "two"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /policy allows 1/);
  assert.equal(fs.existsSync(path.join(stateDir, "worktrees")), false, "no worktree is created when refused");
});
