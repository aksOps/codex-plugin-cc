import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writePolicy } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import {
  commitWorktreeChanges,
  createJobWorktree,
  findOutOfBoundsChanges,
  getWorktreeDiff,
  isWithin,
  listWorktreeChangedFiles,
  removeJobWorktree,
  resolveJobWorktreePath
} from "../plugins/codex/scripts/lib/worktree.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function seedRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function snapshotTree(repo) {
  const entries = run("git", ["status", "--porcelain"], { cwd: repo }).stdout;
  const head = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  return { entries, head };
}

test("a job worktree lives outside the active checkout and on its own branch", () => {
  const repo = seedRepo();

  const isolation = createJobWorktree(repo, "task-iso1");

  assert.equal(isolation.path, resolveJobWorktreePath(repo, "task-iso1"));
  assert.equal(isolation.branch, "codex/task-iso1");
  assert.equal(isWithin(resolveStateDir(repo), isolation.path), true);
  assert.equal(isWithin(repo, isolation.path), false, "the worktree must not sit inside the checkout");
  assert.equal(fs.existsSync(path.join(isolation.path, "src", "index.mjs")), true);

  removeJobWorktree(repo, "task-iso1", { deleteBranch: true });
});

test("replaying a job id is refused rather than reusing a dirty worktree", () => {
  const repo = seedRepo();
  createJobWorktree(repo, "task-replay");

  assert.throws(() => createJobWorktree(repo, "task-replay"), /already exists/);

  // Removing the worktree keeps the branch, so the produced history survives and the id is
  // still refused for reuse.
  removeJobWorktree(repo, "task-replay");
  assert.throws(() => createJobWorktree(repo, "task-replay"), /Branch codex\/task-replay already exists/);

  removeJobWorktree(repo, "task-replay", { deleteBranch: true });
});

test("edits inside the worktree never reach the active checkout", () => {
  const repo = seedRepo();
  const before = snapshotTree(repo);

  const isolation = createJobWorktree(repo, "task-iso2");
  fs.writeFileSync(path.join(isolation.path, "src", "index.mjs"), "export const value = 2;\n");
  fs.writeFileSync(path.join(isolation.path, "src", "added.mjs"), "export const added = true;\n");

  assert.deepEqual(listWorktreeChangedFiles(isolation.path), ["src/added.mjs", "src/index.mjs"]);
  assert.equal(fs.readFileSync(path.join(repo, "src", "index.mjs"), "utf8"), "export const value = 1;\n");
  assert.equal(fs.existsSync(path.join(repo, "src", "added.mjs")), false);

  const commit = commitWorktreeChanges(isolation.path, "codex: isolation test");
  assert.equal(commit.committed, true);
  assert.match(commit.sha, /^[0-9a-f]{40}$/);

  const diff = getWorktreeDiff(isolation.path, isolation.baseSha);
  assert.deepEqual(diff.files, ["src/added.mjs", "src/index.mjs"]);
  assert.match(diff.diff, /export const value = 2;/);

  assert.deepEqual(snapshotTree(repo), before, "the active checkout must be untouched");

  removeJobWorktree(repo, "task-iso2", { deleteBranch: true });
});

test("containment checks reject symlink escapes", () => {
  const repo = seedRepo();
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, "target.txt"), "outside\n");

  const isolation = createJobWorktree(repo, "task-iso3");
  fs.symlinkSync(outside, path.join(isolation.path, "escape"));

  assert.equal(isWithin(isolation.path, path.join(isolation.path, "escape", "target.txt")), false);
  assert.equal(isWithin(isolation.path, path.join(isolation.path, "src", "index.mjs")), true);

  removeJobWorktree(repo, "task-iso3", { deleteBranch: true });
});

test("out-of-glob changes are reported as violations", () => {
  const repo = seedRepo();
  const isolation = createJobWorktree(repo, "task-iso4");
  fs.writeFileSync(path.join(isolation.path, "src", "ok.mjs"), "export const ok = true;\n");
  fs.writeFileSync(path.join(isolation.path, "not-allowed.env"), "TOKEN=nope\n");

  const changed = listWorktreeChangedFiles(isolation.path);
  const violations = findOutOfBoundsChanges(isolation.path, changed, (relativePath) =>
    relativePath.startsWith("src/")
  );

  assert.deepEqual(violations, [
    { path: "not-allowed.env", reason: "not covered by the agent's writable globs" }
  ]);

  removeJobWorktree(repo, "task-iso4", { deleteBranch: true });
});

test("a write task edits its worktree and leaves the checkout clean", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["src/**"] } }
  });
  const before = snapshotTree(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.agent, "implement");
  assert.equal(payload.capability, "write");
  assert.deepEqual(payload.isolation.changedFiles, ["src/generated.txt"]);
  assert.deepEqual(payload.isolation.violations, []);
  assert.match(payload.isolation.branch, /^codex\/task-/);
  assert.match(payload.isolation.commitSha, /^[0-9a-f]{40}$/);

  assert.equal(fs.existsSync(path.join(payload.isolation.worktreePath, "src", "generated.txt")), true);
  assert.equal(fs.existsSync(path.join(repo, "src", "generated.txt")), false);
  assert.deepEqual(snapshotTree(repo), before, "the active checkout must be untouched");
});

test("a write task refuses to record changes outside the agent's writable globs", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-out-of-policy");
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["src/**"] } }
  });
  const before = snapshotTree(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "touch a secret"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.isolation.commitSha, null, "out-of-policy changes must not be committed");
  assert.deepEqual(payload.isolation.violations, [
    { path: "not-allowed.env", reason: "not covered by the agent's writable globs" }
  ]);
  assert.deepEqual(snapshotTree(repo), before, "the active checkout must be untouched");
});

test("a write task without a policy file is denied before any worktree is created", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Write execution is denied/);
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "worktrees")), false);
});

test("read-only agents run against the checkout without creating a worktree", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  writePolicy(repo);

  const result = run("node", [SCRIPT, "task", "--agent", "explore", "--json", "look around"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.capability, "read");
  assert.equal(payload.isolation, null);
});
