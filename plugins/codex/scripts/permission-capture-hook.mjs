#!/usr/bin/env node

// PreToolUse hook that records the host permission mode just before a companion command runs.
//
// The mode can be toggled mid-session, so capturing it at SessionStart would go stale. This
// fires on Bash calls and exits immediately unless the command is a companion invocation, so
// the cost on unrelated Bash calls is one short-lived process that reads stdin and returns.
//
// The hook never blocks a tool call: any failure here is silent and the companion falls back
// to its restrictive default.

import fs from "node:fs";
import process from "node:process";

import { writePermissionRecord } from "./lib/permission-mode.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const COMPANION_MARKER = "codex-companion.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const input = readHookInput();

  const command = String(input?.tool_input?.command ?? "");
  if (!command.includes(COMPANION_MARKER)) {
    return;
  }

  const sessionId = input.session_id;
  const permissionMode = input.permission_mode;
  if (!sessionId || !permissionMode) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  writePermissionRecord(resolveWorkspaceRoot(cwd), {
    sessionId,
    promptId: input.prompt_id ?? null,
    permissionMode,
    capturedAt: new Date().toISOString()
  });
}

try {
  main();
} catch {
  // A capture failure must never block the tool call it observed.
}
