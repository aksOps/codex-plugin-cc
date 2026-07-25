import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getWorktreeDiff, WorktreeError } from "./worktree.mjs";
import {
  branchExists,
  git,
  reapStepWorktree,
  stepBranch,
} from "./step-worktree-state.mjs";

export {
  cleanupStepWorktreeLeftover,
  findStepWorktree,
  reapStepWorktree,
  recoverStepWorktree,
} from "./step-worktree-state.mjs";

async function withUntracked(worktreePath, operation) {
  const result = await git(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = result.stdout
    .split("\0")
    .filter(
      (file) =>
        file !== "" && file !== ".fleet" && !file.startsWith(".fleet/"),
    );
  if (untracked.length > 0) {
    await git(worktreePath, [
      "add",
      "--intent-to-add",
      "--",
      ...untracked.map((file) => `:(literal)${file}`),
    ]);
  }
  try {
    return await operation();
  } finally {
    if (untracked.length > 0) {
      await git(worktreePath, [
        "reset",
        "--quiet",
        "--",
        ...untracked.map((file) => `:(literal)${file}`),
      ]);
    }
  }
}

async function changedFiles(worktreePath) {
  return withUntracked(worktreePath, async () => {
    const result = await git(worktreePath, [
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      "--",
      ".",
      ":(exclude).fleet/**",
    ]);
    return result.stdout.split("\0").filter((file) => file !== "");
  });
}

export async function createStepWorktree({ run, stepId }) {
  const branch = stepBranch(run.runId, stepId);
  if (await branchExists(run.repoRoot, branch)) {
    throw new WorktreeError(
      `Fleet child branch collision: ${branch} already exists.`,
    );
  }
  const ownedRoot = await mkdtemp(
    join(tmpdir(), `fleet-${run.runId}-${stepId}-`),
  );
  const worktreePath = join(ownedRoot, "worktree");
  const child = {
    repoPath: run.repoRoot,
    runId: run.runId,
    stepId,
    branch,
    worktreePath,
    ownedRoot,
  };
  let registered = false;
  try {
    await git(run.worktreePath, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ]);
    registered = true;
    const seed = await getWorktreeDiff(run.worktreePath);
    if (seed !== "") {
      const patchPath = join(ownedRoot, "seed.patch");
      await writeFile(patchPath, seed, "utf8");
      await git(worktreePath, ["apply", "--binary", patchPath]);
      await rm(patchPath);
      await git(worktreePath, ["add", "--all"]);
      await git(worktreePath, [
        "commit",
        "--quiet",
        "-m",
        "fleet: seed Step child from Run diff",
      ]);
    }
    return child;
  } catch (error) {
    if (registered) {
      await reapStepWorktree(child);
    } else {
      await rm(ownedRoot, { recursive: true, force: true });
    }
    throw new WorktreeError(
      `Failed to create child worktree for Step ${stepId}.`,
      { cause: error },
    );
  }
}

export async function discardStepWorktree(child) {
  let diffBefore;
  try {
    diffBefore = await getWorktreeDiff(child.worktreePath);
  } finally {
    await reapStepWorktree(child);
  }
  return { diffBefore, diffAfter: "" };
}

export async function mergeStepWorktree({ child, run, files }) {
  const changed = await changedFiles(child.worktreePath);
  const allowed = new Set(files);
  const violation = changed.find((file) => !allowed.has(file));
  if (violation !== undefined) {
    throw new WorktreeError(
      `Step ${child.stepId} changed undeclared file ${violation}.`,
    );
  }
  const diff = await getWorktreeDiff(child.worktreePath);
  let replayed = false;
  if (diff !== "") {
    const patchPath = join(child.ownedRoot, "merge.patch");
    await writeFile(patchPath, diff, "utf8");
    try {
      await git(run.worktreePath, ["apply", "--check", "--binary", patchPath]);
      await git(run.worktreePath, ["apply", "--binary", patchPath]);
    } catch (forwardError) {
      try {
        await git(run.worktreePath, [
          "apply",
          "--reverse",
          "--check",
          "--binary",
          patchPath,
        ]);
        replayed = true;
      } catch {
        throw new WorktreeError(
          `Step ${child.stepId} diff conflicts with the Run worktree.`,
          { cause: forwardError },
        );
      }
    }
  }
  await reapStepWorktree(child);
  return { changedFiles: changed, diff, replayed };
}
