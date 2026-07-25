import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, writePolicy } from "./helpers.mjs";
import {
  listBuiltInAgents,
  loadPolicy,
  matchesAnyGlob,
  POLICY_RELATIVE_PATH,
  resolveAgentCapability
} from "../plugins/codex/scripts/lib/policy.mjs";

function writeRawPolicy(repo, contents) {
  const policyPath = path.join(repo, POLICY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, contents, "utf8");
  return policyPath;
}

test("a missing policy file denies every write capability", () => {
  const repo = makeTempDir();

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /No policy file/);

  const capability = resolveAgentCapability(repo, "implement", { write: true });
  assert.equal(capability.allowed, false);
  assert.equal(capability.capability, "read");
  assert.match(capability.reason, /Write execution is denied/);
});

test("read-only agents still run without a policy file", () => {
  const repo = makeTempDir();

  const capability = resolveAgentCapability(repo, "explore", { write: false });
  assert.equal(capability.allowed, true);
  assert.equal(capability.capability, "read");
  assert.deepEqual(capability.writableGlobs, []);
});

test("malformed policy JSON denies write instead of falling back to permissive defaults", () => {
  const repo = makeTempDir();
  writeRawPolicy(repo, "{ not json");

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /not valid JSON/);
  assert.equal(resolveAgentCapability(repo, "implement", { write: true }).allowed, false);
});

test("an unsupported policy version denies write", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 99, agents: { implement: { capability: "write", writableGlobs: ["**"] } } });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /declares version 99/);
  assert.equal(resolveAgentCapability(repo, "implement", { write: true }).allowed, false);
});

test("a write agent with no writable globs is rejected as invalid policy", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 1, agents: { implement: { capability: "write", writableGlobs: [] } } });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /must list at least one glob/);
});

test("writable globs may not escape the repository", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 1, agents: { implement: { capability: "write", writableGlobs: ["../outside/**"] } } });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /must not traverse upward/);
});

test("an agent declared read-only in policy cannot be run as a write agent", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 1, agents: { implement: { capability: "read" } } });

  const capability = resolveAgentCapability(repo, "implement", { write: true });
  assert.equal(capability.allowed, false);
  assert.match(capability.reason, /declares agent "implement" as read-only/);
});

test("an agent missing from policy cannot write", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 1, agents: { explore: { capability: "read" } } });

  const capability = resolveAgentCapability(repo, "implement", { write: true });
  assert.equal(capability.allowed, false);
  assert.match(capability.reason, /does not declare an entry for agent "implement"/);
});

test("a declared write agent resolves with its globs", () => {
  const repo = makeTempDir();
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["src/**", "docs/*.md"] } }
  });

  const capability = resolveAgentCapability(repo, "implement", { write: true });
  assert.equal(capability.allowed, true);
  assert.equal(capability.capability, "write");
  assert.deepEqual(capability.writableGlobs, ["src/**", "docs/*.md"]);
});

test("unknown agent names are refused", () => {
  const repo = makeTempDir();
  writePolicy(repo);

  const capability = resolveAgentCapability(repo, "definitely-not-an-agent", { write: true });
  assert.equal(capability.allowed, false);
  assert.match(capability.reason, /Unknown Codex agent/);
  assert.deepEqual(listBuiltInAgents().sort(), ["explore", "implement", "rescue", "test", "verify"]);
});

test("glob matching is anchored and separator aware", () => {
  assert.equal(matchesAnyGlob("src/index.mjs", ["src/**"]), true);
  assert.equal(matchesAnyGlob("src/nested/deep/index.mjs", ["src/**"]), true);
  assert.equal(matchesAnyGlob("other/src/index.mjs", ["src/**"]), false);
  assert.equal(matchesAnyGlob("srcx/index.mjs", ["src/**"]), false);

  assert.equal(matchesAnyGlob("docs/readme.md", ["docs/*.md"]), true);
  assert.equal(matchesAnyGlob("docs/nested/readme.md", ["docs/*.md"]), false);

  assert.equal(matchesAnyGlob("tests/a.test.mjs", ["**/*.test.*"]), true);
  assert.equal(matchesAnyGlob("a.test.mjs", ["**/*.test.*"]), true);
  assert.equal(matchesAnyGlob("tests/helpers.mjs", ["**/*.test.*"]), false);

  assert.equal(matchesAnyGlob("anything/at/all", ["**"]), true);
  assert.equal(matchesAnyGlob("../escape.txt", ["**"]), false);
  assert.equal(matchesAnyGlob("", ["**"]), false);
});

test("verification entries must be argv arrays, never shell strings", () => {
  const repo = makeTempDir();
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["**"] } },
    verification: [{ id: "unit", argv: "npm test && lint" }]
  });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, false);
  assert.match(loaded.reason, /argv must be a non-empty array/);
});

test("valid verification, limits, and landing sections are normalized", () => {
  const repo = makeTempDir();
  writePolicy(repo, {
    version: 1,
    agents: { implement: { capability: "write", writableGlobs: ["**"] } },
    verification: [{ id: "unit", argv: ["npm", "test"] }],
    limits: { maxConcurrentJobs: 1 },
    landing: { allowAutoLand: true }
  });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, true, loaded.reason ?? "");
  assert.deepEqual(loaded.policy.verification, [
    { id: "unit", argv: ["npm", "test"], expect: { exitCode: 0 }, required: true }
  ]);
  assert.equal(loaded.policy.limits.maxConcurrentJobs, 1);
  assert.equal(loaded.policy.limits.network, "off");
  assert.equal(loaded.policy.landing.allowAutoLand, true);
  assert.equal(loaded.policy.landing.requireCleanTree, true);
});

test("auto-land defaults to disabled when the policy does not opt in", () => {
  const repo = makeTempDir();
  writePolicy(repo, { version: 1, agents: { implement: { capability: "write", writableGlobs: ["**"] } } });

  const loaded = loadPolicy(repo);
  assert.equal(loaded.ok, true, loaded.reason ?? "");
  assert.equal(loaded.policy.landing.allowAutoLand, false);
});
