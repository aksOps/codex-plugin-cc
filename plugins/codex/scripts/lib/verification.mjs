// Structured verification of what a write run produced.
//
// Checks come from the repository policy as argv arrays and run inside the job worktree with
// no shell, so there is no place for a model-supplied success criterion to hide. A result is
// the process exit code, never a model's claim about it. A failing required check is what
// blocks completion and landing.

import { buildIsolatedEnv } from "./env-isolation.mjs";
import { resolveLimits, truncateOutput } from "./limits.mjs";
import { runCommand } from "./process.mjs";
import { assertWithin } from "./worktree.mjs";

const TAIL_BYTES = 4096;

function describe(argv) {
  return argv.join(" ");
}

/**
 * Run the policy's verification checks against a job worktree.
 *
 * @param {string} worktreePath
 * @param {object | null} policy
 * @param {{ env?: NodeJS.ProcessEnv, onProgress?: (message: string) => void }} [options]
 * @returns {{ ran: boolean, passed: boolean, checks: Array<object>, skippedReason: string | null }}
 */
export function runVerification(worktreePath, policy, options = {}) {
  const checks = policy?.verification ?? [];
  if (checks.length === 0) {
    return {
      ran: false,
      passed: true,
      checks: [],
      skippedReason: "The policy declares no verification commands."
    };
  }

  const limits = resolveLimits(policy);
  const { env } = buildIsolatedEnv(options.env ?? process.env, {
    passthrough: limits.envPassthrough
  });

  const results = [];
  for (const check of checks) {
    options.onProgress?.(`Verifying: ${check.id} (${describe(check.argv)})`);

    const [command, ...args] = check.argv;
    const result = runCommand(command, args, {
      cwd: worktreePath,
      env,
      shell: false,
      timeout: limits.maxDurationMs,
      maxBuffer: limits.maxOutputBytes + 1
    });

    const expectedExitCode = check.expect?.exitCode ?? 0;
    const spawnFailed = Boolean(result.error);
    const exitCode = spawnFailed ? null : result.status;
    const ok = !spawnFailed && exitCode === expectedExitCode;
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    results.push({
      id: check.id,
      argv: [...check.argv],
      required: check.required !== false,
      expectedExitCode,
      exitCode,
      ok,
      error: spawnFailed ? String(result.error.message ?? result.error) : null,
      outputTail: truncateOutput(combined, TAIL_BYTES).text
    });

    options.onProgress?.(`Verification ${check.id}: ${ok ? "passed" : "failed"}.`);
  }

  return {
    ran: true,
    passed: results.every((entry) => entry.ok || !entry.required),
    checks: results,
    skippedReason: null
  };
}

/**
 * Verification only means something when it runs against the produced worktree, so refuse a
 * path that is not the job's own.
 */
export function verifyJobWorktree(worktreePath, expectedRoot, policy, options = {}) {
  assertWithin(expectedRoot, worktreePath, "verification working directory");
  return runVerification(worktreePath, policy, options);
}

export function summarizeVerification(verification) {
  if (!verification || !verification.ran) {
    return verification?.skippedReason ?? "Verification did not run.";
  }
  return verification.checks
    .map((check) => `${check.id}: ${check.ok ? "passed" : `failed (exit ${check.exitCode ?? "spawn error"})`}`)
    .join(", ");
}
