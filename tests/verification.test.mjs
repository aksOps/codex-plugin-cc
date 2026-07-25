import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writePolicy } from "./helpers.mjs";
import { loadPolicy } from "../plugins/codex/scripts/lib/policy.mjs";
import { runVerification, summarizeVerification } from "../plugins/codex/scripts/lib/verification.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function policyWith(verification, extra = {}) {
  return {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["src/**"] } },
    verification,
    ...extra
  };
}

function loadedPolicy(repo, policy) {
  writePolicy(repo, policy);
  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, true, loaded.reason ?? "");
  return loaded.policy;
}

function seedRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("no declared checks means verification is skipped, not silently passed off as run", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(repo, policyWith(undefined));

  const result = runVerification(repo, policy);

  assert.equal(result.ran, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks, []);
  assert.match(summarizeVerification(result), /declares no verification commands/);
});

test("a passing check reports its exit code", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(repo, policyWith([{ id: "ok", argv: ["node", "-e", "process.exit(0)"] }]));

  const result = runVerification(repo, policy);

  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].exitCode, 0);
  assert.equal(result.checks[0].ok, true);
  assert.equal(summarizeVerification(result), "ok: passed");
});

test("a failing required check fails the run", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(repo, policyWith([{ id: "unit", argv: ["node", "-e", "process.exit(3)"] }]));

  const result = runVerification(repo, policy);

  assert.equal(result.passed, false);
  assert.equal(result.checks[0].exitCode, 3);
  assert.equal(result.checks[0].required, true);
  assert.match(summarizeVerification(result), /unit: failed \(exit 3\)/);
});

test("a failing optional check does not fail the run", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(
    repo,
    policyWith([{ id: "lint", argv: ["node", "-e", "process.exit(1)"], required: false }])
  );

  const result = runVerification(repo, policy);

  assert.equal(result.passed, true);
  assert.equal(result.checks[0].ok, false);
});

test("a non-zero expectation is honored", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(
    repo,
    policyWith([{ id: "expects-two", argv: ["node", "-e", "process.exit(2)"], expect: { exitCode: 2 } }])
  );

  assert.equal(runVerification(repo, policy).passed, true);
});

test("argv is never shell-interpreted", () => {
  const repo = makeTempDir();
  const marker = path.join(repo, "shell-ran.txt");
  const policy = loadedPolicy(
    repo,
    policyWith([
      {
        id: "no-shell",
        argv: ["node", "-e", "console.log(process.argv[1])", `&& node -e "require('fs').writeFileSync('${marker}','x')"`]
      }
    ])
  );

  const result = runVerification(repo, policy);

  assert.equal(result.checks[0].ok, true);
  assert.equal(fs.existsSync(marker), false, "a shell operator in an argument must stay literal");
  assert.match(result.checks[0].outputTail, /&& node -e/);
});

test("checks run inside the given worktree", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(repo, policyWith([{ id: "cwd", argv: ["node", "-e", "console.log(process.cwd())"] }]));

  const result = runVerification(repo, policy);

  assert.equal(result.checks[0].outputTail.trim(), fs.realpathSync.native(repo));
});

test("credential environment variables are not visible to a check", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(
    repo,
    policyWith([{ id: "env", argv: ["node", "-e", "console.log(JSON.stringify(Object.keys(process.env).sort()))"] }])
  );

  const result = runVerification(repo, policy, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_TOKEN: "ghp_secret",
      ANTHROPIC_API_KEY: "sk-secret",
      RANDOM_FLAG: "on"
    }
  });

  const names = JSON.parse(result.checks[0].outputTail.trim());
  assert.equal(names.includes("GITHUB_TOKEN"), false);
  assert.equal(names.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(names.includes("RANDOM_FLAG"), false);
  assert.equal(names.includes("PATH"), true);
});

test("a check whose binary is missing is reported as a spawn error, not a pass", () => {
  const repo = makeTempDir();
  const policy = loadedPolicy(repo, policyWith([{ id: "missing", argv: ["definitely-not-a-real-binary-xyz"] }]));

  const result = runVerification(repo, policy);

  assert.equal(result.passed, false);
  assert.equal(result.checks[0].ok, false);
  assert.equal(result.checks[0].exitCode, null);
  assert.match(result.checks[0].error, /ENOENT|spawnSync/i);
});

test("a write task with a failing required check ends verification-failed", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  writePolicy(repo, policyWith([{ id: "unit", argv: ["node", "-e", "process.exit(1)"] }]));

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification.passed, false);
  assert.equal(payload.verification.checks[0].id, "unit");

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(status.status, 0, status.stderr);
  const jobs = JSON.parse(status.stdout);
  const recorded = [...(jobs.recent ?? []), ...(jobs.running ?? []), jobs.latestFinished].filter(Boolean);
  assert.equal(
    recorded.some((job) => job.status === "verification-failed"),
    true,
    `expected a verification-failed job, saw ${JSON.stringify(recorded.map((job) => job.status))}`
  );
});

test("a write task with a passing check stays completed", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  writePolicy(repo, policyWith([{ id: "unit", argv: ["node", "-e", "process.exit(0)"] }]));

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "add a file"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification.passed, true);
  assert.equal(payload.isolation.commitSha !== null, true);
});

test("verification is skipped when a write run produced nothing to verify", () => {
  const repo = seedRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writePolicy(repo, policyWith([{ id: "unit", argv: ["node", "-e", "process.exit(1)"] }]));

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "--json", "do nothing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verification, null);
  assert.equal(payload.isolation.commitSha, null);
});
