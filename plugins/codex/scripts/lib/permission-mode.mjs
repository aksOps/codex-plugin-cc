import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

// The host's permission mode, captured from Claude Code hook input.
//
// This decides whether the plugin pauses, never what Codex may touch. Isolation, writable
// globs, approval decisions, and verification are identical in every mode; only the landing
// step changes. See FORK_SCOPE.md, "Execution and Security".
//
// Trust note, stated plainly: the record below is a file, and a model with shell access can
// write files. It is a convenience signal so an autonomous session is not stalled, not a
// trust boundary. Nothing that protects the user's checkout depends on it.

export const PERMISSION_MODES = new Set([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions"
]);

// Modes where the user has already told the host to stop asking before applying edits.
const AUTO_LAND_MODES = new Set(["acceptEdits", "auto", "dontAsk", "bypassPermissions"]);

// Plan mode means "do not change anything", so a write agent must not run at all.
const WRITE_REFUSED_MODES = new Set(["plan"]);

const RECORD_PREFIX = "permission-";
export const RECORD_MAX_AGE_MS = 120000;
const FALLBACK_MODE = "default";

export function resolvePermissionRecordPath(workspaceRoot, sessionId) {
  const safeSessionId = String(sessionId ?? "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
  return path.join(resolveStateDir(workspaceRoot), `${RECORD_PREFIX}${safeSessionId}.json`);
}

export function writePermissionRecord(workspaceRoot, record) {
  const recordPath = resolvePermissionRecordPath(workspaceRoot, record.sessionId);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

function isFreshEnough(record, now, maxAgeMs) {
  const capturedAt = Date.parse(record?.capturedAt ?? "");
  if (!Number.isFinite(capturedAt)) {
    return false;
  }
  return now - capturedAt <= maxAgeMs && capturedAt - now <= maxAgeMs;
}

/**
 * Resolve the host permission mode for the current session.
 *
 * A missing, unreadable, malformed, or stale record resolves to the most restrictive
 * interpretation: writes are allowed, but nothing is ever landed automatically.
 *
 * @returns {{ mode: string, source: "record" | "missing" | "stale" | "invalid",
 *             autoLand: boolean, writeAllowed: boolean, reason: string | null }}
 */
export function readPermissionMode(workspaceRoot, sessionId, options = {}) {
  const restrictive = (source, reason) => ({
    mode: FALLBACK_MODE,
    source,
    autoLand: false,
    writeAllowed: true,
    reason
  });

  if (!sessionId) {
    return restrictive("missing", "No Claude session id is available for this run.");
  }

  const recordPath = resolvePermissionRecordPath(workspaceRoot, sessionId);
  if (!fs.existsSync(recordPath)) {
    return restrictive("missing", "No permission-mode record was captured for this session.");
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch (error) {
    return restrictive("invalid", `The permission-mode record is unreadable: ${error.message}`);
  }

  if (!PERMISSION_MODES.has(record?.permissionMode)) {
    return restrictive("invalid", `Unrecognized permission mode ${JSON.stringify(record?.permissionMode)}.`);
  }

  const now = options.now ?? Date.now();
  if (!isFreshEnough(record, now, options.maxAgeMs ?? RECORD_MAX_AGE_MS)) {
    return restrictive("stale", "The captured permission mode is too old to act on.");
  }

  const mode = record.permissionMode;
  return {
    mode,
    source: "record",
    autoLand: AUTO_LAND_MODES.has(mode),
    writeAllowed: !WRITE_REFUSED_MODES.has(mode),
    reason: null
  };
}

export function describePermissionMode(resolved) {
  if (resolved.source === "record") {
    return `host permission mode: ${resolved.mode}`;
  }
  return `host permission mode unavailable (${resolved.source}); treating as ${resolved.mode}`;
}

export { AUTO_LAND_MODES, WRITE_REFUSED_MODES, FALLBACK_MODE };
