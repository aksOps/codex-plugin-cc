import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { commandIsAllowed, createApprovalHandler, resolveAllowedCommands } from "../plugins/codex/scripts/lib/approvals.mjs";

function handlerFor(options = {}) {
  const worktreePath = options.worktreePath ?? makeTempDir();
  const decisions = [];
  const handle = createApprovalHandler({
    worktreePath,
    allowedCommands: options.allowedCommands ?? [],
    onDecision: (decision) => decisions.push(decision)
  });
  return { worktreePath, decisions, handle };
}

test("an approval handler requires a worktree root", () => {
  assert.throws(() => createApprovalHandler({}), /needs the job worktree path/);
});

test("a patch outside the writable root is denied with the offending paths", () => {
  const { handle, decisions } = handlerFor();

  const response = handle({
    method: "applyPatchApproval",
    params: {
      conversationId: "thr_1",
      callId: "call_1",
      fileChanges: { "/etc/passwd": { type: "update" }, "../escape.txt": { type: "add" } },
      reason: null,
      grantRoot: null
    }
  });

  assert.equal(response.decision.denied.rejection.includes("/etc/passwd"), true);
  assert.equal(response.decision.denied.rejection.includes("../escape.txt"), true);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, false);
  assert.equal(decisions[0].kind, "fileChange");
});

test("a session-wide write grant is always refused", () => {
  const { handle, worktreePath, decisions } = handlerFor();

  const response = handle({
    method: "applyPatchApproval",
    params: { fileChanges: {}, grantRoot: worktreePath }
  });

  assert.match(response.decision.denied.rejection, /session-wide write grant/i);
  assert.equal(decisions[0].grantRoot, worktreePath);
});

test("the modern file-change approval shape is declined", () => {
  const { handle } = handlerFor();

  const response = handle({
    method: "item/fileChange/requestApproval",
    params: { threadId: "t", turnId: "u", itemId: "i", startedAtMs: 0 }
  });

  assert.deepEqual(response, { decision: "decline" });
});

test("a command outside the worktree is denied even when the policy allows the argv", () => {
  const { handle, decisions } = handlerFor({ allowedCommands: [["npm", "test"]] });
  const elsewhere = makeTempDir();

  const response = handle({
    method: "execCommandApproval",
    params: { command: ["npm", "test"], cwd: elsewhere }
  });

  assert.match(response.decision.denied.rejection, /outside the job worktree/);
  assert.equal(decisions[0].allowed, false);
});

test("a command the policy does not list is denied inside the worktree", () => {
  const { handle, worktreePath } = handlerFor({ allowedCommands: [["npm", "test"]] });

  const response = handle({
    method: "execCommandApproval",
    params: { command: ["curl", "https://example.com"], cwd: worktreePath }
  });

  assert.match(response.decision.denied.rejection, /policy does not allow/);
});

test("a policy-listed command inside the worktree is approved", () => {
  const { handle, worktreePath, decisions } = handlerFor({ allowedCommands: [["npm", "test"]] });

  const response = handle({
    method: "execCommandApproval",
    params: { command: ["npm", "test", "--silent"], cwd: worktreePath }
  });

  assert.deepEqual(response, { decision: "approved" });
  assert.equal(decisions[0].allowed, true);

  const modern = handle({
    method: "item/commandExecution/requestApproval",
    params: { command: ["npm", "test"], cwd: worktreePath }
  });
  assert.deepEqual(modern, { decision: "accept" });
});

test("a command with no declared cwd is denied", () => {
  const { handle } = handlerFor({ allowedCommands: [["npm", "test"]] });

  const response = handle({ method: "execCommandApproval", params: { command: ["npm", "test"] } });

  assert.match(response.decision.denied.rejection, /no declared working directory/);
});

test("command matching is by exact argv prefix", () => {
  assert.equal(commandIsAllowed(["npm", "test"], [["npm", "test"]]), true);
  assert.equal(commandIsAllowed(["npm", "test", "--silent"], [["npm", "test"]]), true);
  assert.equal(commandIsAllowed(["npm", "publish"], [["npm", "test"]]), false);
  assert.equal(commandIsAllowed(["npm"], [["npm", "test"]]), false);
  assert.equal(commandIsAllowed(["npmx", "test"], [["npm", "test"]]), false);
  assert.equal(commandIsAllowed(["npm", "test"], []), false);
  assert.equal(commandIsAllowed([], [["npm", "test"]]), false);
});

test("permission-profile requests fall through to a protocol-level refusal", () => {
  const { handle, decisions } = handlerFor();

  const response = handle({ method: "item/permissions/requestApproval", params: {} });

  assert.equal(response, undefined);
  assert.equal(decisions[0].kind, "permissions");
  assert.equal(decisions[0].allowed, false);
});

test("unrelated server requests keep the historical refusal", () => {
  const { handle, decisions } = handlerFor();

  assert.equal(handle({ method: "item/tool/requestUserInput", params: {} }), undefined);
  assert.equal(handle({ method: "mcpServer/elicitation/request", params: {} }), undefined);
  assert.equal(decisions.length, 0);
});

test("a symlink inside the worktree cannot smuggle a command out of it", () => {
  const worktreePath = makeTempDir();
  const outside = makeTempDir();
  fs.symlinkSync(outside, path.join(worktreePath, "escape"));
  const { handle } = handlerFor({ worktreePath, allowedCommands: [["npm", "test"]] });

  const response = handle({
    method: "execCommandApproval",
    params: { command: ["npm", "test"], cwd: path.join(worktreePath, "escape") }
  });

  assert.match(response.decision.denied.rejection, /outside the job worktree/);
});

test("allowed commands come only from an explicit policy list", () => {
  assert.deepEqual(resolveAllowedCommands(null), []);
  assert.deepEqual(resolveAllowedCommands({ limits: {} }), []);
  assert.deepEqual(resolveAllowedCommands({ limits: { allowedCommands: [["npm", "test"], "bad", [1]] } }), [
    ["npm", "test"]
  ]);
});
