import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

// Per-job git worktrees. Write-capable Codex runs never execute against the user's active
// checkout: they get a detached worktree under the plugin state directory, on their own
// branch, and every path Codex touches is checked for containment before it is accepted.

const WORKTREES_DIR_NAME = "worktrees";
const BRANCH_PREFIX = "codex/";

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function realPath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function resolveWorktreesDir(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), WORKTREES_DIR_NAME);
}

export function resolveJobWorktreePath(workspaceRoot, jobId) {
  return path.join(resolveWorktreesDir(workspaceRoot), jobId);
}

export function resolveJobBranch(jobId) {
  return `${BRANCH_PREFIX}${jobId}`;
}

/**
 * True when `candidate` is `root` itself or lives beneath it, after resolving symlinks on
 * both sides. Used to fail closed on symlink escapes.
 */
export function isWithin(root, candidate) {
  const resolvedRoot = realPath(root);
  const resolvedCandidate = realPath(candidate);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  return resolvedCandidate.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`);
}

export function assertWithin(root, candidate, label = "path") {
  if (!isWithin(root, candidate)) {
    throw new Error(`Refusing to operate on ${label} outside the job worktree: ${candidate}`);
  }
  return candidate;
}

/**
 * Create the isolated worktree for a job.
 *
 * @returns {{ path: string, branch: string, baseSha: string, baseBranch: string }}
 */
export function createJobWorktree(workspaceRoot, jobId) {
  const headSha = git(workspaceRoot, ["rev-parse", "HEAD"]);
  if (headSha.status !== 0) {
    throw new Error(
      "Write-capable Codex work needs at least one commit in this repository. Commit something first, then retry."
    );
  }

  const worktreePath = resolveJobWorktreePath(workspaceRoot, jobId);
  if (fs.existsSync(worktreePath)) {
    throw new Error(`A worktree for job ${jobId} already exists at ${worktreePath}. Cancel or clean up that job first.`);
  }

  const branch = resolveJobBranch(jobId);
  const existingBranch = git(workspaceRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existingBranch.status === 0) {
    throw new Error(`Branch ${branch} already exists. Job ids must not be replayed.`);
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  gitChecked(workspaceRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

  const baseBranch = git(workspaceRoot, ["branch", "--show-current"]).stdout.trim() || "HEAD";
  return {
    path: worktreePath,
    branch,
    baseSha: headSha.stdout.trim(),
    baseBranch
  };
}

export function listWorktreeChangedFiles(worktreePath) {
  const tracked = gitChecked(worktreePath, ["diff", "--name-only", "HEAD"]).stdout;
  const untracked = gitChecked(worktreePath, ["ls-files", "--others", "--exclude-standard"]).stdout;
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
}

/**
 * Verify every changed path is inside the worktree and, for write agents, inside the
 * policy's writable globs. Returns the offending paths rather than throwing so the caller
 * can report all of them at once.
 */
export function findOutOfBoundsChanges(worktreePath, changedFiles, isAllowedPath) {
  const violations = [];
  for (const relativePath of changedFiles) {
    const absolutePath = path.resolve(worktreePath, relativePath);
    if (!isWithin(worktreePath, absolutePath)) {
      violations.push({ path: relativePath, reason: "outside the job worktree" });
      continue;
    }
    if (!isAllowedPath(relativePath)) {
      violations.push({ path: relativePath, reason: "not covered by the agent's writable globs" });
    }
  }
  return violations;
}

export function worktreeHasChanges(worktreePath) {
  return listWorktreeChangedFiles(worktreePath).length > 0;
}

/**
 * Commit whatever Codex produced onto the job branch so it can be reviewed and cherry-picked.
 * Repository hooks are skipped: this commit is plugin bookkeeping, not a user commit.
 *
 * @returns {{ committed: boolean, sha: string | null }}
 */
export function commitWorktreeChanges(worktreePath, message, options = {}) {
  if (!worktreeHasChanges(worktreePath)) {
    return { committed: false, sha: null };
  }

  gitChecked(worktreePath, ["add", "--all"]);
  gitChecked(worktreePath, [
    "-c",
    `user.name=${options.authorName ?? "Codex Plugin"}`,
    "-c",
    `user.email=${options.authorEmail ?? "codex-plugin@localhost"}`,
    "commit",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    message
  ]);

  return {
    committed: true,
    sha: gitChecked(worktreePath, ["rev-parse", "HEAD"]).stdout.trim()
  };
}

/**
 * @returns {{ diff: string, stat: string, files: string[] }}
 */
export function getWorktreeDiff(worktreePath, baseSha, options = {}) {
  const range = `${baseSha}..HEAD`;
  const maxBuffer = options.maxBytes ?? 4 * 1024 * 1024;
  return {
    diff: gitChecked(worktreePath, ["diff", range], { maxBuffer }).stdout,
    stat: gitChecked(worktreePath, ["diff", "--stat", range], { maxBuffer }).stdout,
    files: gitChecked(worktreePath, ["diff", "--name-only", range], { maxBuffer })
      .stdout.split("\n")
      .filter(Boolean)
  };
}

export function removeJobWorktree(workspaceRoot, jobId, options = {}) {
  const worktreePath = resolveJobWorktreePath(workspaceRoot, jobId);
  if (fs.existsSync(worktreePath)) {
    git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]);
  }
  git(workspaceRoot, ["worktree", "prune"]);

  if (options.deleteBranch) {
    git(workspaceRoot, ["branch", "-D", resolveJobBranch(jobId)]);
  }
  return !fs.existsSync(worktreePath);
}
