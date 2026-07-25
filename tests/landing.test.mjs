import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writePolicy } from "./helpers.mjs";
import { landJob, resolveLandingAuthorization } from "../plugins/codex/scripts/lib/landing.mjs";
import { writePermissionRecord } from "../plugins/codex/scripts/lib/permission-mode.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");
const SESSION = "session-land";

const AUTO_LAND_POLICY = {
  version: 1,
  agents: { implement: { capability: "write", writableGlobs: ["src/**"] } },
  landing: { allowAutoLand: true, requireCleanTree: true }
};

function seedRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function envFor(binDir) {
  return { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: SESSION };
}

/**
 * Commit the policy file. An uncommitted policy leaves the tree dirty, and landing refuses a
 * dirty tree, so a realistic repository has its policy checked in.
 */
function commitPolicy(repo, policy) {
  writePolicy(repo, policy);
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "add policy"], { cwd: repo });
}

function recordMode(repo, permissionMode) {
  writePermissionRecord(repo, {
    sessionId: SESSION,
    promptId: "p1",
    permissionMode,
    capturedAt: new Date().toISOString()
  });
}

function headSha(repo) {
  return run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
}

test("explicit invocation authorizes landing regardless of permission mode", () => {
  assert.deepEqual(resolveLandingAuthorization({ explicit: true }), {
    authorized: true,
    via: "explicit",
    reason: null
  });
});

test("automatic landing needs both the policy opt-in and an auto-land host mode", () => {
  const policy = { landing: { allowAutoLand: true, requireCleanTree: true } };

  assert.equal(resolveLandingAuthorization({ permission: { autoLand: true, mode: "auto" }, policy }).authorized, true);

  const modeRefused = resolveLandingAuthorization({ permission: { autoLand: false, mode: "default" }, policy });
  assert.equal(modeRefused.authorized, false);
  assert.match(modeRefused.reason, /does not authorize automatic landing/);

  const policyRefused = resolveLandingAuthorization({
    permission: { autoLand: true, mode: "bypassPermissions" },
    policy: { landing: { allowAutoLand: false } }
  });
  assert.equal(policyRefused.authorized, false);
  assert.match(policyRefused.reason, /allowAutoLand to false/);
});

test("a job that failed verification is never landed", () => {
  const repo = seedRepo();
  const result = landJob({
    workspaceRoot: repo,
    storedJob: { id: "task-1", status: "verification-failed", result: {} },
    explicit: true
  });

  assert.equal(result.landed, false);
  assert.match(result.reason, /Verification failed/);
});

test("a job with no committed changes is never landed", () => {
  const repo = seedRepo();
  const result = landJob({
    workspaceRoot: repo,
    storedJob: { id: "task-1", status: "completed", result: { isolation: { commitSha: null } } },
    explicit: true
  });

  assert.equal(result.landed, false);
  assert.match(result.reason, /recorded no committed changes/);
});

test("a job with policy violations is never landed", () => {
  const repo = seedRepo();
  const result = landJob({
    workspaceRoot: repo,
    storedJob: {
      id: "task-1",
      status: "completed",
      result: {
        isolation: {
          commitSha: "abc",
          worktreePath: repo,
          branch: "codex/task-1",
          violations: [{ path: "secrets.env", reason: "not covered by the agent's writable globs" }]
        }
      }
    },
    explicit: true
  });

  assert.equal(result.landed, false);
  assert.match(result.reason, /outside its writable globs/);
});

test("an auto-land host mode lands a verified diff and records an audit trail", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, AUTO_LAND_POLICY);
  recordMode(repo, "bypassPermissions");
  const before = headSha(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.permission.mode, "bypassPermissions");
  assert.equal(payload.permission.autoLand, true);
  assert.notEqual(payload.landed, null, "a verified diff should land in bypassPermissions");
  assert.equal(payload.landed.authorizedBy, "permission-mode");
  assert.equal(payload.landed.permissionMode, "bypassPermissions");
  assert.match(payload.landed.note, /never pushes/);

  assert.notEqual(headSha(repo), before, "the landed commit should be on the checkout");
  assert.equal(fs.existsSync(path.join(repo, "src", "generated.txt")), true);
});

test("default mode leaves the diff in the worktree and the checkout untouched", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, AUTO_LAND_POLICY);
  recordMode(repo, "default");
  const before = headSha(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.landed, null);
  assert.equal(headSha(repo), before);
  assert.equal(fs.existsSync(path.join(repo, "src", "generated.txt")), false);

  const diff = run("node", [SCRIPT, "diff", payload.isolation.branch.replace("codex/", "")], {
    cwd: repo,
    env: envFor(binDir)
  });
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /To land this yourself/);
  assert.match(diff.stdout, /git cherry-pick FETCH_HEAD/);
});

test("policy can refuse automatic landing even under bypassPermissions", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, {
    ...AUTO_LAND_POLICY,
    landing: { allowAutoLand: false, requireCleanTree: true }
  });
  recordMode(repo, "bypassPermissions");
  const before = headSha(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).landed, null);
  assert.equal(headSha(repo), before);
});

test("a failing verification blocks automatic landing under bypassPermissions", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, {
    ...AUTO_LAND_POLICY,
    verification: [{ id: "unit", argv: ["node", "-e", "process.exit(1)"] }]
  });
  recordMode(repo, "bypassPermissions");
  const before = headSha(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification.passed, false);
  assert.equal(payload.landed, null);
  assert.equal(headSha(repo), before);
});

test("a dirty working tree blocks automatic landing", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, AUTO_LAND_POLICY);
  recordMode(repo, "bypassPermissions");
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 99;\n");
  const before = headSha(repo);

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).landed, null);
  assert.equal(headSha(repo), before);
  assert.equal(fs.readFileSync(path.join(repo, "src", "index.mjs"), "utf8"), "export const value = 99;\n");
});

test("landing never issues a push", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, AUTO_LAND_POLICY);
  recordMode(repo, "bypassPermissions");

  // A bare remote that would record any push, plus a tracking branch to push onto.
  const remote = makeTempDir();
  run("git", ["init", "--bare", "-b", "main"], { cwd: remote });
  run("git", ["remote", "add", "origin", remote], { cwd: repo });
  run("git", ["push", "-u", "origin", "main"], { cwd: repo });
  const remoteHeadBefore = run("git", ["rev-parse", "main"], { cwd: remote }).stdout.trim();

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).landed, null, "the diff should have landed locally");
  assert.equal(
    run("git", ["rev-parse", "main"], { cwd: remote }).stdout.trim(),
    remoteHeadBefore,
    "the remote must be untouched"
  );
});

test("explicit land applies a diff that default mode left alone", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  commitPolicy(repo, AUTO_LAND_POLICY);
  recordMode(repo, "default");
  const before = headSha(repo);

  const task = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: envFor(binDir)
  });
  assert.equal(task.status, 0, task.stderr);
  const jobId = JSON.parse(task.stdout).isolation.branch.replace("codex/", "");
  assert.equal(headSha(repo), before);

  const land = run("node", [SCRIPT, "land", jobId, "--json"], { cwd: repo, env: envFor(binDir) });

  assert.equal(land.status, 0, land.stderr);
  const audit = JSON.parse(land.stdout).audit;
  assert.equal(audit.authorizedBy, "explicit");
  assert.equal(audit.jobId, jobId);
  assert.notEqual(headSha(repo), before);
  assert.equal(fs.existsSync(path.join(repo, "src", "generated.txt")), true);

  const secondLand = run("node", [SCRIPT, "land", jobId, "--json"], { cwd: repo, env: envFor(binDir) });
  assert.notEqual(secondLand.status, 0, "landing the same job twice should fail rather than duplicate it");
});
