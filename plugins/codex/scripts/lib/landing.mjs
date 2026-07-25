import { getWorkingTreeState } from "./git.mjs";
import { DEFAULT_LANDING } from "./policy.mjs";
import { runCommand } from "./process.mjs";
import { nowIso } from "./tracked-jobs.mjs";

// The one place a Codex diff can reach the user's branch.
//
// Interactive and autonomous landing share this entry point so they cannot drift apart: the
// host permission mode decides only whether authorization is present, never which checks run.
// Landing is always a local commit. No push, no force-push, no remote merge, ever.

const NEVER_PUSH_NOTE = "Landing performs a local cherry-pick only; it never pushes.";

function git(cwd, args) {
  return runCommand("git", args, { cwd, shell: false });
}

function refusal(reason) {
  return { landed: false, reason, commitSha: null, audit: null };
}

export function resolveLandingPolicy(policy) {
  return { ...DEFAULT_LANDING, ...(policy?.landing ?? {}) };
}

/**
 * Decide whether this land is authorized, without performing it.
 *
 * @returns {{ authorized: boolean, via: "explicit" | "permission-mode" | null, reason: string | null }}
 */
export function resolveLandingAuthorization({ explicit = false, permission = null, policy = null } = {}) {
  if (explicit) {
    return { authorized: true, via: "explicit", reason: null };
  }

  const landing = resolveLandingPolicy(policy);
  if (!landing.allowAutoLand) {
    return {
      authorized: false,
      via: null,
      reason: "The repository policy sets landing.allowAutoLand to false, so nothing lands automatically."
    };
  }
  if (!permission?.autoLand) {
    return {
      authorized: false,
      via: null,
      reason: `The host permission mode does not authorize automatic landing (${permission?.mode ?? "unknown"}).`
    };
  }

  return { authorized: true, via: "permission-mode", reason: null };
}

/**
 * Land a finished job's branch onto the current branch of the target repository.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot   Repository receiving the change.
 * @param {object} options.storedJob       Job record, including its stored result payload.
 * @param {object | null} options.policy
 * @param {object | null} options.permission  Result of readPermissionMode.
 * @param {boolean} [options.explicit]     True when a human ran /codex:land.
 * @returns {{ landed: boolean, reason: string | null, commitSha: string | null, audit: object | null }}
 */
export function landJob({ workspaceRoot, storedJob, policy = null, permission = null, explicit = false }) {
  if (!storedJob) {
    return refusal("No stored job was found to land.");
  }
  if (storedJob.status === "verification-failed") {
    return refusal("Verification failed for this job, so its diff must not be landed.");
  }
  if (storedJob.status !== "completed") {
    return refusal(`Job ${storedJob.id} is ${storedJob.status}; only a completed job can be landed.`);
  }

  const isolation = storedJob.result?.isolation ?? null;
  if (!isolation?.commitSha || !isolation.worktreePath || !isolation.branch) {
    return refusal(`Job ${storedJob.id} recorded no committed changes to land.`);
  }
  if (Array.isArray(isolation.violations) && isolation.violations.length > 0) {
    return refusal(`Job ${storedJob.id} produced changes outside its writable globs and was never committed.`);
  }

  const verification = storedJob.result?.verification ?? null;
  if (verification && verification.ran && !verification.passed) {
    return refusal("Verification did not pass for this job, so its diff must not be landed.");
  }

  const authorization = resolveLandingAuthorization({ explicit, permission, policy });
  if (!authorization.authorized) {
    return refusal(authorization.reason);
  }

  const landing = resolveLandingPolicy(policy);
  if (landing.requireCleanTree) {
    const state = getWorkingTreeState(workspaceRoot);
    if (state.isDirty) {
      return refusal(
        "The working tree has uncommitted changes. Commit or stash them first so the landed diff stays separable."
      );
    }
  }

  const fetch = git(workspaceRoot, ["fetch", isolation.worktreePath, isolation.branch]);
  if (fetch.status !== 0) {
    return refusal(`Could not fetch ${isolation.branch} from the job worktree: ${fetch.stderr.trim() || "git fetch failed"}`);
  }

  const cherryPick = git(workspaceRoot, ["cherry-pick", "FETCH_HEAD"]);
  if (cherryPick.status !== 0) {
    // Leave no half-applied state behind.
    git(workspaceRoot, ["cherry-pick", "--abort"]);
    return refusal(`Could not cherry-pick ${isolation.commitSha}: ${cherryPick.stderr.trim() || "git cherry-pick failed"}`);
  }

  const landedSha = git(workspaceRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const audit = {
    jobId: storedJob.id,
    sourceCommit: isolation.commitSha,
    sourceBranch: isolation.branch,
    landedCommit: landedSha,
    authorizedBy: authorization.via,
    permissionMode: permission?.mode ?? null,
    permissionSource: permission?.source ?? null,
    verification: verification ? { ran: verification.ran, passed: verification.passed } : null,
    landedAt: nowIso(),
    note: NEVER_PUSH_NOTE
  };

  return { landed: true, reason: null, commitSha: landedSha, audit };
}

export { NEVER_PUSH_NOTE };
