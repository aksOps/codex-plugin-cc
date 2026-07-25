import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";

// Declared locally rather than imported from tracked-jobs.mjs, which imports this module.
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

function nowIso() {
  return new Date().toISOString();
}

// Durable job ownership.
//
// A job record survives the process that created it, so a killed or crashed worker would
// otherwise leave a job that claims to be running forever — blocking the concurrency bound and
// misreporting status. Ownership records who is running a job and until when, and every
// command reconciles before it reads job state.
//
// Liveness has two independent signals so neither alone can strand a job:
//   - the owning pid, checked only when the job is owned by this host; and
//   - a lease deadline, which is all we have for a job owned by another host.

export const LEASE_TTL_MS = 15 * 60 * 1000;
export const STALE_STATUS = "stale";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function buildOwner(options = {}) {
  const env = options.env ?? process.env;
  return {
    sessionId: env[SESSION_ID_ENV] ?? null,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname()
  };
}

export function leaseExpiryFrom(now = Date.now(), ttlMs = LEASE_TTL_MS) {
  return new Date(now + ttlMs).toISOString();
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

/**
 * Decide whether an active job has lost its owner.
 *
 * @returns {{ stale: boolean, reason: string | null }}
 */
export function evaluateJobLiveness(job, options = {}) {
  if (!ACTIVE_STATUSES.has(job?.status)) {
    return { stale: false, reason: null };
  }

  const now = options.now ?? Date.now();
  const hostname = options.hostname ?? os.hostname();
  const owner = job.owner ?? null;
  const sameHost = !owner?.hostname || owner.hostname === hostname;
  const pid = owner?.pid ?? job.pid ?? null;

  if (sameHost && Number.isInteger(pid) && !isProcessAlive(pid)) {
    return { stale: true, reason: `owning process ${pid} is gone` };
  }

  const expiresAt = Date.parse(job.leaseExpiresAt ?? "");
  if (Number.isFinite(expiresAt) && expiresAt < now) {
    return { stale: true, reason: `lease expired at ${job.leaseExpiresAt}` };
  }

  if (!sameHost && !Number.isFinite(expiresAt)) {
    return { stale: true, reason: `owned by ${owner.hostname} with no lease to renew it` };
  }

  return { stale: false, reason: null };
}

/**
 * Mark every active job whose owner is gone as stale. Safe to call from any command; it only
 * ever transitions jobs the owning process can no longer be running.
 *
 * @returns {Array<{ id: string, reason: string }>}
 */
export function reconcileJobOwnership(workspaceRoot, options = {}) {
  const reconciled = [];

  for (const job of listJobs(workspaceRoot)) {
    const liveness = evaluateJobLiveness(job, options);
    if (!liveness.stale) {
      continue;
    }

    const completedAt = nowIso();
    const patch = {
      id: job.id,
      status: STALE_STATUS,
      phase: STALE_STATUS,
      pid: null,
      errorMessage: `Job ownership lost: ${liveness.reason}.`,
      completedAt
    };
    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) {
      writeJobFile(workspaceRoot, job.id, { ...readJobFile(jobFile), ...patch });
    }

    reconciled.push({ id: job.id, reason: liveness.reason });
  }

  return reconciled;
}

/**
 * Ownership fields to merge into a job record as it starts running.
 */
export function claimJob(options = {}) {
  return {
    owner: buildOwner(options),
    leaseExpiresAt: leaseExpiryFrom(options.now ?? Date.now(), options.ttlMs ?? LEASE_TTL_MS)
  };
}

export function renewedLease(options = {}) {
  return { leaseExpiresAt: leaseExpiryFrom(options.now ?? Date.now(), options.ttlMs ?? LEASE_TTL_MS) };
}

export { ACTIVE_STATUSES };
