import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";

import {
  awaitRun,
  cleanupRun,
  cleanupFleetRun,
  createRun,
  getRunDiff,
  getRunStatus,
  runFleet,
  startRun,
} from "../src/fleet/run.mjs";
import { readEvents } from "../src/fleet/events.mjs";
import { digestPlan } from "../src/fleet/plan.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRepository() {
  const repoPath = await mkdtemp(join(tmpdir(), "fleet-source-"));
  temporaryDirectories.push(repoPath);
  await execFileAsync("git", ["init", "--quiet", repoPath]);
  await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Fleet Test"]);
  await execFileAsync("git", [
    "-C",
    repoPath,
    "config",
    "user.email",
    "fleet@example.invalid",
  ]);
  await writeFile(join(repoPath, ".gitignore"), ".fleet/\n", "utf8");
  await writeFile(join(repoPath, "seed.txt"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", repoPath, "add", ".gitignore", "seed.txt"]);
  await execFileAsync("git", ["-C", repoPath, "commit", "--quiet", "-m", "seed"]);
  return repoPath;
}

test("runFleet confines both workers and metadata to the Run worktree", async () => {
  // Given: a source repo, an isolated Codex home, and two writing workers.
  const repoPath = await createRepository();
  const codexHome = await mkdtemp(join(tmpdir(), "fleet-codex-home-"));
  temporaryDirectories.push(codexHome);
  const authPath = join(codexHome, "auth.json");
  await writeFile(authPath, "unchanged\n", "utf8");
  const authBefore = await stat(authPath);
  const sourceStatusBefore = await execFileAsync("git", [
    "-C",
    repoPath,
    "status",
    "--porcelain=v1",
  ]);
  const seenWorktrees = [];
  const codexWorker = async (context) => {
    seenWorktrees.push(context.worktreePath);
    assert.equal(context.codexHome, codexHome);
    await writeFile(join(context.worktreePath, "codex.txt"), "codex\n", "utf8");
    return { finalResponse: "codex complete" };
  };
  const claudeWorker = async (context) => {
    seenWorktrees.push(context.worktreePath);
    await writeFile(join(context.worktreePath, "claude.txt"), "claude\n", "utf8");
    return { finalResponse: "claude complete" };
  };

  // When: Fleet executes one Step on each provider.
  const run = await runFleet({
    repoRoot: repoPath,
    runId: "isolation",
    intent: "write one file per provider",
    codexHome,
    codexWorker,
    claudeWorker,
  });

  // Then: only the external worktree changed and both Routes are reviewable.
  try {
    await assert.rejects(access(join(repoPath, "codex.txt")));
    await assert.rejects(access(join(repoPath, "claude.txt")));
    assert.deepEqual(seenWorktrees, [run.worktreePath, run.worktreePath]);
    assert.notEqual(run.worktreePath, repoPath);
    assert.match(run.diff, /codex\.txt/);
    assert.match(run.diff, /claude\.txt/);
    assert.doesNotMatch(run.diff, /run\.json|events\.jsonl/);
    const metadata = JSON.parse(await readFile(join(run.metadataPath, "run.json"), "utf8"));
    assert.equal(metadata.intent, "write one file per provider");
    const events = await readEvents(run.eventsPath);
    assert.deepEqual(
      events.map((event) => event.provider),
      ["codex", "claude"],
    );
    assert.ok(events.every((event) => event.outcome === "unverified"));
    const sourceStatusAfter = await execFileAsync("git", [
      "-C",
      repoPath,
      "status",
      "--porcelain=v1",
    ]);
    assert.equal(sourceStatusAfter.stdout, sourceStatusBefore.stdout);
    const authAfter = await stat(authPath);
    assert.equal(authAfter.mtimeMs, authBefore.mtimeMs);
  } finally {
    await cleanupFleetRun(run);
  }
});

test("runFleet reaps its worktree when a worker fails", async () => {
  // Given: a Run whose Codex worker fails.
  const repoPath = await createRepository();
  const before = await execFileAsync("git", [
    "-C",
    repoPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  const codexWorker = async () => {
    throw new TypeError("worker failed");
  };
  const claudeWorker = async () => ({ finalResponse: "not reached" });

  // When: the Run is attempted.
  await assert.rejects(
    runFleet({
      repoRoot: repoPath,
      runId: "failure",
      intent: "fail safely",
      codexWorker,
      claudeWorker,
    }),
    /worker failed/,
  );

  // Then: no worktree or Run branch leaked.
  const [after, branch] = await Promise.all([
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
      "fleet/failure",
    ]),
  ]);
  assert.equal(after.stdout, before.stdout);
  assert.equal(branch.stdout.trim(), "");
  await cleanupRun("failure");
  assert.equal(getRunStatus("failure"), null);
});

test("createRun exposes paths and getRunDiff presents externally forwarded work", async () => {
  // Given: an MCP-style Run whose provider writes through the exposed worktree.
  const repoPath = await createRepository();
  const created = await createRun({
    repoRoot: repoPath,
    runId: "external-forward",
    intent: "forward one provider",
    planMarkdown: "# Fleet Plan\nIntent: forward one provider\n",
  });
  await writeFile(
    join(created.worktreePath, "forwarded.txt"),
    "forwarded\n",
    "utf8",
  );

  // When: the MCP integration asks Fleet for the current review diff.
  const diff = await getRunDiff(created.runId);

  // Then: paths remain discoverable and the external write is reviewable.
  try {
    const status = getRunStatus(created.runId);
    assert.equal(status.worktreePath, created.worktreePath);
    assert.equal(status.eventsPath, created.eventsPath);
    assert.equal(
      await readFile(status.planPath, "utf8"),
      "# Fleet Plan\nIntent: forward one provider\n",
    );
    assert.equal(status.diff, diff);
    assert.match(diff, /forwarded\.txt/);
  } finally {
    await cleanupFleetRun(created);
  }
});

test("createRun digests the exact normalized Plan bytes it persists", async () => {
  // Given: approved Plan Markdown without a trailing newline.
  const repoPath = await createRepository();
  const plan = "# Fleet Plan\nIntent: normalize bytes";
  const created = await createRun({
    repoRoot: repoPath,
    runId: "normalized-plan",
    intent: "normalize bytes",
    planMarkdown: plan,
  });

  try {
    // When: the persisted contract is read after Run creation.
    const persisted = await readFile(created.planPath, "utf8");

    // Then: the digest binds the exact on-disk bytes used after a restart.
    assert.equal(persisted, `${plan}\n`);
    assert.equal(created.planDigest, digestPlan(persisted));
  } finally {
    await cleanupFleetRun(created);
  }
});

test("startRun exposes running status and awaitRun resolves its result", async () => {
  // Given: a Run whose first worker is held at an explicit completion gate.
  const repoPath = await createRepository();
  let releaseCodex;
  const codexGate = new Promise((resolve) => {
    releaseCodex = resolve;
  });
  const codexWorker = async () => {
    await codexGate;
    return { finalResponse: "codex complete" };
  };
  const claudeWorker = async () => ({ finalResponse: "claude complete" });

  // When: Fleet starts the Run without awaiting worker completion.
  const started = await startRun({
    repoRoot: repoPath,
    runId: "asynchronous",
    intent: "start and await",
    codexWorker,
    claudeWorker,
  });

  // Then: status is observable until the caller explicitly awaits completion.
  try {
    assert.equal(started.state, "running");
    releaseCodex();
    const completed = await awaitRun(started.runId);
    assert.equal(completed.state, "completed");
    assert.equal(getRunStatus(started.runId).state, "completed");
  } finally {
    await cleanupRun(started.runId);
  }
});
