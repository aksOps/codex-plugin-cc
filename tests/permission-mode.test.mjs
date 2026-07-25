import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, writePolicy } from "./helpers.mjs";
import {
  RECORD_MAX_AGE_MS,
  readPermissionMode,
  resolvePermissionRecordPath,
  writePermissionRecord
} from "../plugins/codex/scripts/lib/permission-mode.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const CAPTURE_HOOK = path.join(PLUGIN_ROOT, "scripts", "permission-capture-hook.mjs");

const SESSION = "session-abc";

function record(repo, permissionMode, capturedAt = new Date().toISOString()) {
  return writePermissionRecord(repo, { sessionId: SESSION, promptId: "p1", permissionMode, capturedAt });
}

test("each host mode maps to the documented landing behavior", () => {
  const expectations = [
    ["default", { autoLand: false, writeAllowed: true }],
    ["plan", { autoLand: false, writeAllowed: false }],
    ["acceptEdits", { autoLand: true, writeAllowed: true }],
    ["auto", { autoLand: true, writeAllowed: true }],
    ["dontAsk", { autoLand: true, writeAllowed: true }],
    ["bypassPermissions", { autoLand: true, writeAllowed: true }]
  ];

  for (const [mode, expected] of expectations) {
    const repo = makeTempDir();
    record(repo, mode);
    const resolved = readPermissionMode(repo, SESSION);
    assert.equal(resolved.mode, mode);
    assert.equal(resolved.source, "record");
    assert.equal(resolved.autoLand, expected.autoLand, `${mode} autoLand`);
    assert.equal(resolved.writeAllowed, expected.writeAllowed, `${mode} writeAllowed`);
  }
});

test("a missing record falls back to the restrictive default", () => {
  const repo = makeTempDir();

  const resolved = readPermissionMode(repo, SESSION);

  assert.equal(resolved.mode, "default");
  assert.equal(resolved.source, "missing");
  assert.equal(resolved.autoLand, false);
  assert.equal(resolved.writeAllowed, true);
});

test("a stale record is rejected rather than trusted", () => {
  const repo = makeTempDir();
  const stale = new Date(Date.now() - RECORD_MAX_AGE_MS - 5000).toISOString();
  record(repo, "bypassPermissions", stale);

  const resolved = readPermissionMode(repo, SESSION);

  assert.equal(resolved.source, "stale");
  assert.equal(resolved.autoLand, false);
});

test("a record timestamped in the future is rejected", () => {
  const repo = makeTempDir();
  record(repo, "bypassPermissions", new Date(Date.now() + RECORD_MAX_AGE_MS + 5000).toISOString());

  assert.equal(readPermissionMode(repo, SESSION).source, "stale");
});

test("an unrecognized or malformed record is rejected", () => {
  const repo = makeTempDir();
  record(repo, "bypassPermissions");
  fs.writeFileSync(resolvePermissionRecordPath(repo, SESSION), '{"permissionMode":"yolo"}', "utf8");
  assert.equal(readPermissionMode(repo, SESSION).source, "invalid");

  fs.writeFileSync(resolvePermissionRecordPath(repo, SESSION), "{ not json", "utf8");
  assert.equal(readPermissionMode(repo, SESSION).source, "invalid");
});

test("no session id means no automatic landing", () => {
  const repo = makeTempDir();
  record(repo, "bypassPermissions");

  const resolved = readPermissionMode(repo, null);

  assert.equal(resolved.source, "missing");
  assert.equal(resolved.autoLand, false);
});

test("the capture hook ignores Bash calls that are not companion commands", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const result = run("node", [CAPTURE_HOOK], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      permission_mode: "bypassPermissions",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "ls -la" }
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(resolvePermissionRecordPath(repo, SESSION)), false);
});

test("the capture hook records the mode for a companion command", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const result = run("node", [CAPTURE_HOOK], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      prompt_id: "prompt-1",
      permission_mode: "auto",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: `node "${SCRIPT}" task --write hello` }
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(fs.readFileSync(resolvePermissionRecordPath(repo, SESSION), "utf8"));
  assert.equal(stored.permissionMode, "auto");
  assert.equal(stored.promptId, "prompt-1");
  assert.equal(readPermissionMode(repo, SESSION).autoLand, true);
});

test("the capture hook never fails a tool call on malformed input", () => {
  const repo = makeTempDir();
  const result = run("node", [CAPTURE_HOOK], { cwd: repo, input: "not json at all" });
  assert.equal(result.status, 0, result.stderr);
});

test("plan mode refuses a write agent before any worktree is created", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "writes-in-policy");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.mjs"), "export const value = 1;\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  writePolicy(repo, { version: 1, agents: { implement: { capability: "write", writableGlobs: ["src/**"] } } });
  record(repo, "plan");

  const result = run("node", [SCRIPT, "task", "--write", "--agent", "implement", "do it"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: SESSION }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refused while the host is in plan mode/);
  assert.equal(fs.existsSync(path.join(resolveStateDir(repo), "worktrees")), false);
});

test("plan mode still allows a read-only agent", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  record(repo, "plan");

  const result = run("node", [SCRIPT, "task", "--agent", "explore", "--json", "look"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_SESSION_ID: SESSION }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).capability, "read");
});
