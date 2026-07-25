import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

import {
  createRunWorktree,
  getWorktreeDiff,
  reapRunWorktree,
} from "../src/fleet/worktree.mjs";
import {
  cleanupStepWorktreeLeftover,
  createStepWorktree,
  findStepWorktree,
  mergeStepWorktree,
  reapStepWorktree,
  recoverStepWorktree,
} from "../src/fleet/step-worktree.mjs";
import { reconcileFinalizations } from "../src/mcp/finalization.mjs";

const execFileAsync = promisify(execFile);
const temporaryRepositories = [];

after(async () => {
  await Promise.all(
    temporaryRepositories.map((repoPath) =>
      rm(repoPath, { recursive: true, force: true }),
    ),
  );
});

async function createRepository() {
  const repoPath = await mkdtemp(join(tmpdir(), "fleet-repo-"));
  temporaryRepositories.push(repoPath);
  await execFileAsync("git", ["init", "--quiet", repoPath]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Fleet Test"]);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "config",
    "user.email",
    "fleet@example.invalid",
  ]);
  await writeFile(join(repoPath, "seed.txt"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", repoPath, "add", "seed.txt"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "--quiet", "-m", "seed"]);
  return repoPath;
}

async function git(repoPath, ...args) {
  return execFileAsync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
}

test("createRunWorktree creates a separate branch-backed worktree", async () => {
  // Given: a committed source repository.
  const repoPath = await createRepository();

  // When: Fleet creates a Run worktree.
  const run = await createRunWorktree({ repoPath, runId: "walk-1" });

  // Then: Git reports the external worktree and its dedicated branch.
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "list",
      "--porcelain",
    ]);
    assert.notEqual(run.worktreePath, repoPath);
    assert.match(stdout, new RegExp(`worktree ${run.worktreePath}`));
    assert.match(stdout, /branch refs\/heads\/fleet\/walk-1/);
  } finally {
    await reapRunWorktree(run);
  }
});

test("reapRunWorktree removes both worktree and branch", async () => {
  // Given: an active Fleet worktree.
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "walk-reap" });

  // When: Fleet reaps the Run.
  await reapRunWorktree(run);

  // Then: no worktree or branch remains registered.
  const [{ stdout: worktrees }, branch] = await Promise.all([
    execFileAsync("git", [
      "-C",
      repoPath,
      "worktree",
      "list",
      "--porcelain",
    ]),
    execFileAsync("git", [
      "-C",
      repoPath,
      "branch",
      "--list",
      "fleet/walk-reap",
    ]),
  ]);
  assert.doesNotMatch(worktrees, new RegExp(`worktree ${run.worktreePath}`));
  assert.equal(branch.stdout.trim(), "");
});

test("createRunWorktree rejects a worktree root inside the source repository", async () => {
  // Given: a committed source repository.
  const repoPath = await createRepository();

  // When: a Run requests an in-repository worktree root.
  const creation = createRunWorktree({
    repoPath,
    runId: "inside-source",
    worktreeRoot: join(repoPath, ".fleet-worktrees"),
  });

  // Then: Fleet rejects the path before registering a worktree.
  await assert.rejects(creation, /outside the source repository/);
  await assert.rejects(access(join(repoPath, ".fleet-worktrees")));
});

test("child worktrees seed Run diffs and merge only into the Run worktree", async () => {
  // Given
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "child-merge" });
  await writeFile(join(run.worktreePath, "seed.txt"), "dependency output\n", "utf8");
  const child = await createStepWorktree({ run: { ...run, repoRoot: repoPath }, stepId: "left" });

  try {
    // When
    assert.equal(
      await readFile(join(child.worktreePath, "seed.txt"), "utf8"),
      "dependency output\n",
    );
    await writeFile(join(child.worktreePath, "left.txt"), "left\n", "utf8");
    const merged = await mergeStepWorktree({
      child,
      run: { ...run, repoRoot: repoPath },
      files: ["left.txt"],
    });

    // Then
    assert.deepEqual(merged.changedFiles, ["left.txt"]);
    assert.equal(
      await readFile(join(run.worktreePath, "left.txt"), "utf8"),
      "left\n",
    );
  } catch (error) {
    await reapStepWorktree(child);
    throw error;
  } finally {
    assert.equal(await readFile(join(repoPath, "seed.txt"), "utf8"), "seed\n");
    await reapRunWorktree(run);
  }
});

test("ownership violations preserve the child until guardrail cleanup", async () => {
  // Given
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "child-guard" });
  const child = await createStepWorktree({ run: { ...run, repoRoot: repoPath }, stepId: "guard" });
  await writeFile(join(child.worktreePath, "undeclared.txt"), "nope\n", "utf8");

  // When / Then
  await assert.rejects(
    mergeStepWorktree({
      child,
      run: { ...run, repoRoot: repoPath },
      files: ["declared.txt"],
    }),
    /undeclared file undeclared\.txt/,
  );
  const { stdout } = await execFileAsync("git", [
    "-C",
    repoPath,
    "branch",
    "--list",
    child.branch,
  ]);
  assert.notEqual(stdout.trim(), "");
  await reapStepWorktree(child);
  assert.equal(
    (await git(repoPath, "branch", "--list", child.branch)).stdout.trim(),
    "",
  );
  await reapRunWorktree(run);
});

test("a pre-existing deterministic child branch survives creation collision", async () => {
  // Given
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "collision" });
  const branch = "fleet/collision-step-owned";
  await git(repoPath, "branch", branch, "HEAD");
  const before = (await git(repoPath, "rev-parse", branch)).stdout.trim();

  // When
  await assert.rejects(
    createStepWorktree({
      run: { ...run, repoRoot: repoPath },
      stepId: "owned",
    }),
    /already exists|collision/i,
  );

  // Then
  const after = (await git(repoPath, "rev-parse", branch)).stdout.trim();
  assert.equal(after, before);
  await git(repoPath, "branch", "-D", branch);
  await reapRunWorktree(run);
});

test("merge replay recognizes an already-applied exact patch and reaps", async () => {
  // Given
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "merge-replay" });
  const child = await createStepWorktree({
    run: { ...run, repoRoot: repoPath },
    stepId: "replay",
  });
  await writeFile(join(child.worktreePath, "replay.txt"), "once\n", "utf8");
  const patchPath = join(child.ownedRoot, "pre-applied.patch");
  await writeFile(patchPath, await getWorktreeDiff(child.worktreePath), "utf8");
  await git(run.worktreePath, "apply", "--binary", patchPath);

  // When
  const merged = await mergeStepWorktree({
    child,
    run: { ...run, repoRoot: repoPath },
    files: ["replay.txt"],
  });

  // Then
  assert.equal(merged.replayed, true);
  assert.equal(await readFile(join(run.worktreePath, "replay.txt"), "utf8"), "once\n");
  assert.equal((await git(repoPath, "branch", "--list", child.branch)).stdout.trim(), "");
  await reapRunWorktree(run);
});

test("Event recovery removes a proven branch-only child leftover", async () => {
  // Given
  const repoPath = await createRepository();
  const run = await createRunWorktree({ repoPath, runId: "branch-only" });
  const publicRun = { ...run, repoRoot: repoPath, eventsPath: "/tmp/events" };
  const child = await createStepWorktree({
    run: publicRun,
    stepId: "crash",
  });
  await git(repoPath, "worktree", "remove", "--force", child.worktreePath);
  assert.notEqual(
    (await git(repoPath, "branch", "--list", child.branch)).stdout.trim(),
    "",
  );
  const receipts = [];

  // When
  await reconcileFinalizations({
    run: publicRun,
    plan: { steps: [{ id: "crash", files: ["crash.txt"] }] },
    events: [{
      runId: run.runId,
      stepId: "crash",
      rung: 1,
      outcome: "pass",
      attemptWorktreePath: child.worktreePath,
    }],
    dependencies: {
      recoverStepWorktree,
      findStepWorktree,
      cleanupStepWorktreeLeftover,
      appendEvent: async (_path, event) => receipts.push(event),
    },
  });

  // Then
  assert.equal(receipts[0].action, "already-missing");
  assert.equal(
    (await git(repoPath, "branch", "--list", child.branch)).stdout.trim(),
    "",
  );
  await assert.rejects(access(child.ownedRoot));
  assert.doesNotMatch(
    (await git(repoPath, "worktree", "list", "--porcelain")).stdout,
    new RegExp(child.worktreePath),
  );
  await reapRunWorktree(run);
});
