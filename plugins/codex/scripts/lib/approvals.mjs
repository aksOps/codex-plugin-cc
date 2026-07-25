import { isWithin } from "./worktree.mjs";

// Policy-decided answers to Codex's approval requests.
//
// A write turn runs with sandbox "workspace-write" and the job worktree as its cwd, so
// ordinary edits inside the worktree never produce an approval request. An approval request
// therefore means Codex is asking to step *outside* those limits: write beyond the writable
// root, hold a session-wide write grant, or run a command the sandbox blocked.
//
// Every such request is refused unless the repository policy explicitly allows it. No part of
// this decision consults the model, and nothing about it changes with the host permission
// mode: permission modes govern whether the plugin pauses, never what Codex may touch.

const FILE_CHANGE_METHODS = new Set(["applyPatchApproval", "item/fileChange/requestApproval"]);
const COMMAND_METHODS = new Set(["execCommandApproval", "item/commandExecution/requestApproval"]);
const PERMISSION_METHODS = new Set(["item/permissions/requestApproval"]);

const LEGACY_FILE_CHANGE_METHOD = "applyPatchApproval";
const LEGACY_COMMAND_METHOD = "execCommandApproval";

function legacyDenial(rejection) {
  return { decision: { denied: { rejection } } };
}

function legacyApproval() {
  return { decision: "approved" };
}

function describeCommand(command) {
  return Array.isArray(command) ? command.join(" ") : String(command ?? "");
}

/**
 * A command is allowed only when the policy lists its exact argv prefix and it runs inside the
 * job worktree. Prefix matching lets a policy allow `npm test` without also allowing
 * `npm publish`.
 */
function commandIsAllowed(command, allowedCommands) {
  if (!Array.isArray(command) || command.length === 0) {
    return false;
  }
  return allowedCommands.some(
    (allowed) =>
      Array.isArray(allowed) &&
      allowed.length > 0 &&
      allowed.length <= command.length &&
      allowed.every((argument, index) => argument === command[index])
  );
}

/**
 * Build the request handler for a write-capable turn.
 *
 * @param {object} options
 * @param {string} options.worktreePath  Root the turn is confined to.
 * @param {string[][]} [options.allowedCommands]  argv prefixes the policy permits outside the sandbox.
 * @param {(decision: object) => void} [options.onDecision]  Audit sink; receives every decision.
 * @returns {(message: { method: string, params: any }) => unknown}
 */
export function createApprovalHandler({ worktreePath, allowedCommands = [], onDecision } = {}) {
  if (!worktreePath) {
    throw new Error("An approval handler needs the job worktree path.");
  }

  const record = (decision) => {
    onDecision?.(decision);
    return decision;
  };

  return ({ method, params }) => {
    if (FILE_CHANGE_METHODS.has(method)) {
      const grantRoot = params?.grantRoot ?? null;
      const paths = Object.keys(params?.fileChanges ?? {});
      const reason = grantRoot
        ? `Refused a session-wide write grant for ${grantRoot}. Writes stay confined to the job worktree.`
        : paths.length > 0
          ? `Refused a patch outside the writable root: ${paths.join(", ")}`
          : "Refused a file change that requires stepping outside the job worktree.";

      record({ kind: "fileChange", method, allowed: false, reason, paths, grantRoot });
      return method === LEGACY_FILE_CHANGE_METHOD ? legacyDenial(reason) : { decision: "decline" };
    }

    if (COMMAND_METHODS.has(method)) {
      const command = params?.command ?? params?.parsedCmd?.command ?? null;
      const commandCwd = params?.cwd ?? null;
      const insideWorktree = commandCwd ? isWithin(worktreePath, commandCwd) : false;
      const allowed = insideWorktree && commandIsAllowed(command, allowedCommands);

      if (allowed) {
        record({ kind: "command", method, allowed: true, reason: null, command, cwd: commandCwd });
        return method === LEGACY_COMMAND_METHOD ? legacyApproval() : { decision: "accept" };
      }

      const reason = !commandCwd
        ? "Refused a command with no declared working directory."
        : !insideWorktree
          ? `Refused a command running outside the job worktree (${commandCwd}).`
          : `Refused a command the policy does not allow: ${describeCommand(command)}`;

      record({ kind: "command", method, allowed: false, reason, command, cwd: commandCwd });
      return method === LEGACY_COMMAND_METHOD ? legacyDenial(reason) : { decision: "decline" };
    }

    if (PERMISSION_METHODS.has(method)) {
      // There is no "deny" shape for a permission grant, so refuse at the protocol level.
      record({
        kind: "permissions",
        method,
        allowed: false,
        reason: "Refused an expanded permission profile. Capability comes from the repository policy."
      });
      return undefined;
    }

    // Anything else keeps the historical refusal, including tool user input, MCP elicitation,
    // and attestation requests.
    return undefined;
  };
}

/**
 * argv prefixes a policy may allow outside the sandbox. Kept separate from the policy loader so
 * that an absent list means "allow nothing", not "allow the defaults".
 */
export function resolveAllowedCommands(policy) {
  const configured = policy?.limits?.allowedCommands;
  if (!Array.isArray(configured)) {
    return [];
  }
  return configured.filter((entry) => Array.isArray(entry) && entry.every((value) => typeof value === "string"));
}

export { commandIsAllowed, FILE_CHANGE_METHODS, COMMAND_METHODS };
