import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

export const DEFAULT_TEST_POLICY = {
  version: 1,
  agents: {
    rescue: { capability: "write", writableGlobs: ["**"] },
    implement: { capability: "write", writableGlobs: ["**"] },
    test: { capability: "write", writableGlobs: ["tests/**", "**/*.test.*"] },
    explore: { capability: "read" },
    verify: { capability: "read" }
  }
};

/**
 * Write an execution policy into a fixture repository. Write-capable runs are denied without
 * one, so any test that exercises `--write` needs this.
 */
export function writePolicy(cwd, policy = DEFAULT_TEST_POLICY) {
  const policyDir = path.join(cwd, ".codex-plugin");
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return path.join(policyDir, "policy.json");
}
