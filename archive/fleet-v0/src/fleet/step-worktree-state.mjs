import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function stepBranch(runId, stepId) {
  return `fleet/${runId}-step-${stepId}`;
}

export async function git(repoPath, args) {
  return execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function branchExists(repoPath, branch) {
  try {
    await git(repoPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === 1) {
      return false;
    }
    throw error;
  }
}

async function worktreeForBranch(repoPath, branch) {
  const listed = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const expected = `branch refs/heads/${branch}`;
  for (const block of listed.stdout.trim().split("\n\n")) {
    const lines = block.split("\n");
    if (lines.includes(expected)) {
      return (
        lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null
      );
    }
  }
  return null;
}

export async function recoverStepWorktree({ run, stepId, worktreePath }) {
  if (typeof worktreePath !== "string" || worktreePath === "") {
    return null;
  }
  const branch = stepBranch(run.runId, stepId);
  const registeredPath = await worktreeForBranch(run.repoRoot, branch);
  if (registeredPath !== worktreePath) {
    return null;
  }
  return {
    repoPath: run.repoRoot,
    runId: run.runId,
    stepId,
    branch,
    worktreePath,
    ownedRoot: dirname(worktreePath),
  };
}

export async function findStepWorktree({ run, stepId }) {
  const branch = stepBranch(run.runId, stepId);
  const worktreePath = await worktreeForBranch(run.repoRoot, branch);
  if (worktreePath === null) {
    return null;
  }
  return {
    repoPath: run.repoRoot,
    runId: run.runId,
    stepId,
    branch,
    worktreePath,
    ownedRoot: dirname(worktreePath),
  };
}

export async function cleanupStepWorktreeLeftover({
  run,
  stepId,
  worktreePath,
}) {
  if (typeof worktreePath !== "string" || worktreePath === "") {
    return false;
  }
  const ownedRoot = dirname(worktreePath);
  const expectedPrefix = `fleet-${run.runId}-${stepId}-`;
  const rootName = ownedRoot.split("/").at(-1);
  if (
    worktreePath !== `${ownedRoot}/worktree` ||
    dirname(ownedRoot) !== tmpdir() ||
    !rootName.startsWith(expectedPrefix) ||
    rootName.length === expectedPrefix.length
  ) {
    return false;
  }
  const branch = stepBranch(run.runId, stepId);
  const hasBranch = await branchExists(run.repoRoot, branch);
  if (hasBranch && (await worktreeForBranch(run.repoRoot, branch)) !== null) {
    return false;
  }
  let hasRoot = true;
  try {
    await stat(ownedRoot);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      hasRoot = false;
    } else {
      throw error;
    }
  }
  if (hasBranch) {
    await git(run.repoRoot, ["branch", "-D", branch]);
  }
  await rm(ownedRoot, { recursive: true, force: true });
  return hasBranch || hasRoot;
}

export async function reapStepWorktree(child) {
  const listed = await git(child.repoPath, ["worktree", "list", "--porcelain"]);
  if (listed.stdout.includes(`worktree ${child.worktreePath}\n`)) {
    await git(child.repoPath, [
      "worktree",
      "remove",
      "--force",
      child.worktreePath,
    ]);
  }
  if (await branchExists(child.repoPath, child.branch)) {
    await git(child.repoPath, ["branch", "-D", child.branch]);
  }
  await rm(child.ownedRoot, { recursive: true, force: true });
}
