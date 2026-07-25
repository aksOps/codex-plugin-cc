import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJob,
  evaluateJobLiveness,
  isProcessAlive,
  LEASE_TTL_MS,
  leaseExpiryFrom,
  reconcileJobOwnership,
  renewedLease
} from "../plugins/codex/scripts/lib/job-ownership.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const DEAD_PID = 21474836;

function seedState(repo, jobs) {
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );
  return stateDir;
}

function readJobs(repo) {
  return JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8")).jobs;
}

test("liveness only applies to active jobs", () => {
  for (const status of ["completed", "failed", "cancelled", "verification-failed", "stale"]) {
    assert.deepEqual(evaluateJobLiveness({ status, pid: DEAD_PID }), { stale: false, reason: null });
  }
});

test("a live owning process keeps a job active", () => {
  const job = {
    status: "running",
    owner: { pid: process.pid, hostname: os.hostname(), sessionId: "s" },
    leaseExpiresAt: leaseExpiryFrom()
  };
  assert.equal(evaluateJobLiveness(job).stale, false);
});

test("a dead owning process on this host makes a job stale", () => {
  const job = {
    status: "running",
    owner: { pid: DEAD_PID, hostname: os.hostname(), sessionId: "s" },
    leaseExpiresAt: leaseExpiryFrom()
  };

  const liveness = evaluateJobLiveness(job);

  assert.equal(liveness.stale, true);
  assert.match(liveness.reason, /owning process .* is gone/);
});

test("an expired lease makes a job stale even when a pid happens to be alive", () => {
  const job = {
    status: "running",
    owner: { pid: process.pid, hostname: os.hostname(), sessionId: "s" },
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString()
  };

  const liveness = evaluateJobLiveness(job);

  assert.equal(liveness.stale, true);
  assert.match(liveness.reason, /lease expired/);
});

test("a job owned by another host is judged by its lease, not by a local pid", () => {
  const foreign = {
    status: "running",
    owner: { pid: process.pid, hostname: "some-other-host", sessionId: "s" },
    leaseExpiresAt: leaseExpiryFrom()
  };
  assert.equal(evaluateJobLiveness(foreign).stale, false, "a fresh foreign lease is respected");

  const noLease = { status: "running", owner: { pid: 1, hostname: "some-other-host" } };
  const liveness = evaluateJobLiveness(noLease);
  assert.equal(liveness.stale, true);
  assert.match(liveness.reason, /no lease to renew it/);
});

test("isProcessAlive reports honestly", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(-1), false);
});

test("claiming a job records owner and lease", () => {
  const claim = claimJob({ env: { CODEX_COMPANION_SESSION_ID: "session-1" }, now: 1000, ttlMs: 5000 });

  assert.equal(claim.owner.sessionId, "session-1");
  assert.equal(claim.owner.pid, process.pid);
  assert.equal(claim.owner.hostname, os.hostname());
  assert.equal(claim.leaseExpiresAt, new Date(6000).toISOString());
  assert.equal(renewedLease({ now: 0 }).leaseExpiresAt, new Date(LEASE_TTL_MS).toISOString());
});

test("reconciliation marks abandoned jobs stale and leaves live ones alone", () => {
  const repo = makeTempDir();
  seedState(repo, [
    {
      id: "task-dead",
      status: "running",
      jobClass: "task",
      owner: { pid: DEAD_PID, hostname: os.hostname(), sessionId: "s" },
      leaseExpiresAt: leaseExpiryFrom()
    },
    {
      id: "task-live",
      status: "running",
      jobClass: "task",
      owner: { pid: process.pid, hostname: os.hostname(), sessionId: "s" },
      leaseExpiresAt: leaseExpiryFrom()
    },
    { id: "task-done", status: "completed", jobClass: "task" }
  ]);

  const reconciled = reconcileJobOwnership(repo);

  assert.deepEqual(
    reconciled.map((entry) => entry.id),
    ["task-dead"]
  );

  const jobs = Object.fromEntries(readJobs(repo).map((job) => [job.id, job]));
  assert.equal(jobs["task-dead"].status, "stale");
  assert.equal(jobs["task-dead"].phase, "stale");
  assert.equal(jobs["task-dead"].pid, null);
  assert.match(jobs["task-dead"].errorMessage, /Job ownership lost/);
  assert.equal(jobs["task-live"].status, "running");
  assert.equal(jobs["task-done"].status, "completed");
});

test("reconciliation is idempotent", () => {
  const repo = makeTempDir();
  seedState(repo, [
    {
      id: "task-dead",
      status: "queued",
      jobClass: "task",
      owner: { pid: DEAD_PID, hostname: os.hostname(), sessionId: "s" },
      leaseExpiresAt: leaseExpiryFrom()
    }
  ]);

  assert.equal(reconcileJobOwnership(repo).length, 1);
  assert.equal(reconcileJobOwnership(repo).length, 0, "a stale job is not reconciled twice");
});

test("a stale job frees its concurrency slot", () => {
  const repo = makeTempDir();
  seedState(repo, [
    {
      id: "task-dead",
      status: "running",
      jobClass: "task",
      owner: { pid: DEAD_PID, hostname: os.hostname(), sessionId: "s" },
      leaseExpiresAt: leaseExpiryFrom()
    }
  ]);

  reconcileJobOwnership(repo);

  const active = readJobs(repo).filter((job) => job.status === "queued" || job.status === "running");
  assert.deepEqual(active, []);
});
