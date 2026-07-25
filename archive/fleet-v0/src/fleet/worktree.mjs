import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class WorktreeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

async function git(repoPath, args) {
  return execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

export async function createRunWorktree({
  repoPath,
  runId,
  worktreeRoot,
}) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new WorktreeError(`Invalid Fleet Run ID: ${runId}`);
  }

  let repoRoot;
  try {
    const result = await git(resolve(repoPath), [
      "rev-parse",
      "--show-toplevel",
    ]);
    repoRoot = await realpath(result.stdout.trim());
  } catch (error) {
    throw new WorktreeError(`Not a Git repository: ${repoPath}`, {
      cause: error,
    });
  }

  let ownedRoot = null;
  let worktreePath;
  if (worktreeRoot === undefined) {
    ownedRoot = await mkdtemp(join(tmpdir(), `fleet-${runId}-`));
    worktreePath = join(ownedRoot, "worktree");
  } else {
    const requestedRoot = resolve(worktreeRoot);
    if (isWithin(repoRoot, requestedRoot)) {
      throw new WorktreeError("Fleet worktrees must live outside the source repository");
    }
    await mkdir(requestedRoot, { recursive: true });
    const resolvedRoot = await realpath(requestedRoot);
    if (isWithin(repoRoot, resolvedRoot)) {
      throw new WorktreeError("Fleet worktrees must live outside the source repository");
    }
    worktreePath = join(resolvedRoot, runId);
  }

  const branch = `fleet/${runId}`;
  try {
    await git(repoRoot, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ]);
  } catch (error) {
    if (ownedRoot !== null) {
      await rm(ownedRoot, { recursive: true, force: true });
    }
    throw new WorktreeError(`Failed to create Fleet worktree for ${runId}`, {
      cause: error,
    });
  }

  return { repoPath: repoRoot, runId, branch, worktreePath, ownedRoot };
}

export async function getWorktreeDiff(worktreePath) {
  const untrackedResult = await git(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = untrackedResult.stdout
    .split("\0")
    .filter(
      (filePath) =>
        filePath !== "" &&
        filePath !== ".fleet" &&
        !filePath.startsWith(".fleet/"),
    );

  if (untracked.length > 0) {
    await git(worktreePath, [
      "add",
      "--intent-to-add",
      "--",
      ...untracked.map((filePath) => `:(literal)${filePath}`),
    ]);
  }
  try {
    const result = await git(worktreePath, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--",
      ".",
      ":(exclude).fleet/**",
    ]);
    return result.stdout;
  } finally {
    if (untracked.length > 0) {
      await git(worktreePath, [
        "reset",
        "--quiet",
        "--",
        ...untracked.map((filePath) => `:(literal)${filePath}`),
      ]);
    }
  }
}

export async function resetRunWorktree(worktreePath) {
  const diffBefore = await getWorktreeDiff(worktreePath);
  await git(worktreePath, ["reset", "--hard", "HEAD"]);
  await git(worktreePath, ["clean", "-ffd", "-e", ".fleet/"]);
  const diffAfter = await getWorktreeDiff(worktreePath);
  if (diffAfter !== "") {
    throw new WorktreeError(
      `Fleet Run worktree reset left a non-empty diff: ${worktreePath}`,
    );
  }
  return { diffBefore, diffAfter };
}

export async function reapRunWorktree(run) {
  const listed = await git(run.repoPath, ["worktree", "list", "--porcelain"]);
  if (listed.stdout.includes(`worktree ${run.worktreePath}\n`)) {
    await git(run.repoPath, [
      "worktree",
      "remove",
      "--force",
      run.worktreePath,
    ]);
  } else {
    await git(run.repoPath, ["worktree", "prune"]);
  }

  const branch = await git(run.repoPath, [
    "branch",
    "--list",
    run.branch,
  ]);
  if (branch.stdout.trim() !== "") {
    await git(run.repoPath, ["branch", "-D", run.branch]);
  }
  if (run.ownedRoot !== null) {
    await rm(run.ownedRoot, { recursive: true, force: true });
  }
}
