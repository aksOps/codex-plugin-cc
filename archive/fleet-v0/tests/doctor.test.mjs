import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDoctor } from "../src/doctor.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function createPrivateCodexHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-doctor-"));
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome);
  await chmod(codexHome, 0o700);
  return codexHome;
}

test("doctor verifies the complete Stage 1 runtime without PATH Codex", async () => {
  const codexHome = await createPrivateCodexHome();

  const report = await runDoctor({
    repoRoot,
    codexHome,
    environment: {},
    inspectAccount: async () => ({
      authenticated: true,
      authMode: "chatgpt",
      models: ["discovered-model"],
      planType: "pro",
      requiresOpenaiAuth: true,
    }),
    probeGitWorktree: async () => true,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map(({ name }) => name),
    [
      "node",
      "anthropic-base-url",
      "vendored-codex",
      "codex-home",
      "codex-login",
      "codex-models",
      "git-worktree",
      "mcp-tools",
    ],
  );
  assert.equal(
    report.checks.find(({ name }) => name === "vendored-codex").detail
      .usesPath,
    false,
  );
});

test("doctor rejects CODEX_HOME inside the repository", async () => {
  const report = await runDoctor({
    repoRoot,
    codexHome: path.join(repoRoot, ".fleet", "codex-home"),
    environment: {},
    inspectAccount: async () => {
      throw new Error("account inspection must not run after isolation fails");
    },
    probeGitWorktree: async () => true,
  });

  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find(({ name }) => name === "codex-home").status,
    "fail",
  );
});

test("doctor fails loudly when an Anthropic endpoint override is present", async () => {
  const codexHome = await createPrivateCodexHome();

  const report = await runDoctor({
    repoRoot,
    codexHome,
    environment: { ANTHROPIC_BASE_URL: "https://proxy.invalid" },
    inspectAccount: async () => ({
      authenticated: true,
      authMode: "chatgpt",
      models: ["discovered-model"],
      planType: "pro",
      requiresOpenaiAuth: true,
    }),
    probeGitWorktree: async () => true,
  });

  assert.equal(report.ok, false);
  assert.equal(
    report.checks.find(({ name }) => name === "anthropic-base-url").status,
    "fail",
  );
});
