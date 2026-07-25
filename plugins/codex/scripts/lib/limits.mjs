// Resource bounds for Codex jobs: how many may run at once, how long one may run, and how much
// output the plugin will retain. Bounds come from the repository policy, so a repository that
// ships no policy also gets no write jobs and therefore no unbounded ones.

import { DEFAULT_LIMITS } from "./policy.mjs";
import { terminateProcessTree } from "./process.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TRUNCATION_NOTICE = "\n[output truncated by the plugin output limit]\n";

export function resolveLimits(policy) {
  return { ...DEFAULT_LIMITS, ...(policy?.limits ?? {}) };
}

export function countActiveJobs(jobs) {
  return jobs.filter((job) => ACTIVE_STATUSES.has(job?.status)).length;
}

/**
 * Throw when starting another job would exceed the policy's concurrency bound. Read-only work is
 * exempt: the bound exists to cap concurrent write execution and its worktrees.
 */
export function assertConcurrencyAvailable(jobs, policy, options = {}) {
  const limits = resolveLimits(policy);
  const active = countActiveJobs(jobs);
  if (active < limits.maxConcurrentJobs) {
    return { active, limit: limits.maxConcurrentJobs };
  }
  throw new Error(
    `${active} Codex job(s) are already active and the policy allows ${limits.maxConcurrentJobs}. ` +
      `Wait for one to finish or cancel it${options.hint ? ` (${options.hint})` : ""}.`
  );
}

/**
 * Truncate captured output to the policy bound, keeping the tail because failures explain
 * themselves at the end.
 */
export function truncateOutput(text, maxBytes) {
  const value = String(text ?? "");
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LIMITS.maxOutputBytes;
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= limit) {
    return { text: value, truncated: false, originalBytes: buffer.byteLength };
  }
  const keep = Math.max(0, limit - Buffer.byteLength(TRUNCATION_NOTICE, "utf8"));
  return {
    text: `${TRUNCATION_NOTICE}${buffer.subarray(buffer.byteLength - keep).toString("utf8")}`,
    truncated: true,
    originalBytes: buffer.byteLength
  };
}

/**
 * Run `work` under a wall-clock bound. When the deadline passes, the supplied process tree is
 * terminated and the returned promise rejects; a job must not be able to run forever because a
 * model never finished a turn.
 */
export async function withDeadline(work, { maxDurationMs, getPid, onTimeout } = {}) {
  const limit = Number.isInteger(maxDurationMs) && maxDurationMs > 0 ? maxDurationMs : DEFAULT_LIMITS.maxDurationMs;

  let timer = null;
  let timedOut = false;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const pid = getPid?.();
      if (Number.isInteger(pid)) {
        terminateProcessTree(pid);
      }
      onTimeout?.(limit);
      reject(new Error(`Codex run exceeded the policy limit of ${limit}ms and was terminated.`));
    }, limit);
    timer.unref?.();
  });

  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      // Nothing further to clean up here; the caller reports the rejection.
    }
  }
}

export { TRUNCATION_NOTICE };
