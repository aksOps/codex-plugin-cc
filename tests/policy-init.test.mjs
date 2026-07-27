import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { detectRepoProfile, generatePolicy } from "../plugins/codex/scripts/lib/policy-init.mjs";
import { loadPolicy, resolveAgentCapability } from "../plugins/codex/scripts/lib/policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function makeNodeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "x", scripts: { test: "node --test" } })}\n`);
  fs.writeFileSync(path.join(repo, "README.md"), "# x\n");
  return repo;
}

test("a node repository yields npm verification and layout-derived globs", () => {
  const repo = makeNodeRepo();
  const profile = detectRepoProfile(repo);
  assert.equal(profile.toolchain.name, "node");
  assert.deepEqual(profile.sourceDirectories, ["src"]);
  assert.deepEqual(profile.testDirectories, ["tests"]);

  const policy = generatePolicy(profile);
  assert.deepEqual(policy.verification, [
    { id: "test", argv: ["npm", "test"], expect: { exitCode: 0 }, required: true }
  ]);
  assert.equal(policy.agents.implement.writableGlobs.includes("src/**"), true);
  assert.equal(policy.agents.implement.writableGlobs.includes("*.md"), true);
  assert.equal(policy.agents.implement.writableGlobs.includes("node_modules/**"), false);
  assert.equal(policy.agents.test.writableGlobs.includes("tests/**"), true);
  assert.equal(policy.agents.test.writableGlobs.includes("src/**"), false);
  assert.equal(policy.landing.allowAutoLand, false);
});

test("lockfiles pick the package manager for verification", () => {
  const repo = makeNodeRepo();
  fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const policy = generatePolicy(detectRepoProfile(repo));
  assert.deepEqual(policy.verification[0].argv, ["pnpm", "test"]);
});

test("a go repository yields go test and _test.go globs", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "cmd"), { recursive: true });
  fs.mkdirSync(path.join(repo, "internal"), { recursive: true });
  fs.writeFileSync(path.join(repo, "go.mod"), "module example.com/x\n");

  const policy = generatePolicy(detectRepoProfile(repo));
  assert.deepEqual(policy.verification[0].argv, ["go", "test", "./..."]);
  assert.equal(policy.agents.implement.writableGlobs.includes("cmd/**"), true);
  assert.equal(policy.agents.implement.writableGlobs.includes("internal/**"), true);
  assert.equal(policy.agents.test.writableGlobs.includes("**/*_test.go"), true);
});

test("the npm placeholder test script produces no verification entry", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })}\n`
  );
  const policy = generatePolicy(detectRepoProfile(repo));
  assert.deepEqual(policy.verification, []);
});

test("every generated policy loads under the runtime's fail-closed validation", () => {
  const flatRepo = makeTempDir();
  initGitRepo(flatRepo);
  fs.writeFileSync(path.join(flatRepo, "README.md"), "# flat\n");
  fs.writeFileSync(path.join(flatRepo, "tool.sh"), "#!/bin/sh\n");

  for (const repo of [makeNodeRepo(), flatRepo]) {
    const init = run("node", [SCRIPT, "init-policy"], { cwd: repo });
    assert.equal(init.status, 0, init.stderr);

    const loaded = loadPolicy(repo);
    assert.equal(loaded.ok, true, `generated policy must validate: ${loaded.reason}`);

    const capability = resolveAgentCapability(repo, "implement");
    assert.equal(capability.allowed, true);
    assert.equal(capability.capability, "write");
  }
});

test("init-policy refuses to overwrite without --force and honors it with --force", () => {
  const repo = makeNodeRepo();
  const first = run("node", [SCRIPT, "init-policy"], { cwd: repo });
  assert.equal(first.status, 0, first.stderr);

  const policyPath = path.join(repo, ".codex-plugin", "policy.json");
  const sentinel = `${JSON.stringify({ version: 1, agents: { explore: { capability: "read" } } }, null, 2)}\n`;
  fs.writeFileSync(policyPath, sentinel, "utf8");

  const refused = run("node", [SCRIPT, "init-policy"], { cwd: repo });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already exists.*--force/s);
  assert.equal(fs.readFileSync(policyPath, "utf8"), sentinel, "a refused run must not touch the file");

  const forced = run("node", [SCRIPT, "init-policy", "--force"], { cwd: repo });
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(fs.readFileSync(policyPath, "utf8"), sentinel);
  assert.match(forced.stdout, /Regenerated/);
});

test("init-policy --json returns the profile and policy it wrote", () => {
  const repo = makeNodeRepo();
  const result = run("node", [SCRIPT, "init-policy", "--json"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.overwritten, false);
  assert.equal(payload.profile.toolchain.name, "node");
  assert.equal(payload.policy.version, 1);
  assert.equal(fs.existsSync(payload.policyPath), true);
});
