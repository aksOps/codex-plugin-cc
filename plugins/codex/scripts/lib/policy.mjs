import fs from "node:fs";
import path from "node:path";

// Fail-closed capability policy for write-capable Codex agents.
//
// The policy file is optional. When it is absent, unreadable, malformed, or written for an
// unsupported version, every write capability is denied and only read-only agents run.
// Validation is hand-written on purpose: the plugin ships no JSON Schema validator, and a
// silently-skipped validation step would be indistinguishable from a permissive policy.
// schemas/policy.schema.json documents the same shape for editors.

export const POLICY_RELATIVE_PATH = path.join(".codex-plugin", "policy.json");
export const SUPPORTED_POLICY_VERSION = 1;

const CAPABILITIES = new Set(["read", "write"]);

const BUILT_IN_AGENTS = {
  explore: { capability: "read" },
  verify: { capability: "read" },
  implement: { capability: "write" },
  test: { capability: "write" },
  rescue: { capability: "write" }
};

const DEFAULT_LIMITS = {
  maxDurationMs: 900000,
  maxOutputBytes: 1048576,
  maxConcurrentJobs: 3,
  network: "off",
  envPassthrough: ["PATH", "HOME", "LANG"],
  // argv prefixes Codex may run when the sandbox blocks a command. Empty means "allow none".
  allowedCommands: []
};

const DEFAULT_LANDING = {
  allowAutoLand: false,
  requireCleanTree: true
};

export function resolvePolicyPath(repoRoot) {
  return path.join(repoRoot, POLICY_RELATIVE_PATH);
}

/**
 * Convert a policy glob to an anchored RegExp over posix repo-relative paths.
 * Supports `*` (within a segment), `?` (one non-separator character), and `**`.
 */
export function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

export function normalizeRelativePath(relativePath) {
  return String(relativePath ?? "").split(path.sep).join("/").replace(/^\.\//, "");
}

export function matchesAnyGlob(relativePath, globs) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith("../")) {
    return false;
  }
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function invalid(reason) {
  return { ok: false, reason, policy: null };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGlobs(globs, label) {
  if (!Array.isArray(globs)) {
    return `${label}.writableGlobs must be an array.`;
  }
  for (const glob of globs) {
    if (typeof glob !== "string" || !glob.trim()) {
      return `${label}.writableGlobs entries must be non-empty strings.`;
    }
    if (path.isAbsolute(glob) || glob.includes("..")) {
      return `${label}.writableGlobs entries must be repository-relative and must not traverse upward.`;
    }
  }
  return null;
}

function validateAgents(rawAgents) {
  if (!isPlainObject(rawAgents)) {
    return { error: "policy.agents must be an object." };
  }

  const agents = {};
  for (const [name, rawAgent] of Object.entries(rawAgents)) {
    if (!isPlainObject(rawAgent)) {
      return { error: `policy.agents.${name} must be an object.` };
    }
    if (!CAPABILITIES.has(rawAgent.capability)) {
      return { error: `policy.agents.${name}.capability must be "read" or "write".` };
    }
    if (rawAgent.capability === "read") {
      agents[name] = { capability: "read", writableGlobs: [] };
      continue;
    }
    const globError = validateGlobs(rawAgent.writableGlobs, `policy.agents.${name}`);
    if (globError) {
      return { error: globError };
    }
    if (rawAgent.writableGlobs.length === 0) {
      return { error: `policy.agents.${name}.writableGlobs must list at least one glob for a write agent.` };
    }
    agents[name] = {
      capability: "write",
      writableGlobs: [...rawAgent.writableGlobs]
    };
  }
  return { agents };
}

function validateVerification(rawVerification) {
  if (rawVerification === undefined) {
    return { verification: [] };
  }
  if (!Array.isArray(rawVerification)) {
    return { error: "policy.verification must be an array." };
  }

  const verification = [];
  const seen = new Set();
  for (const entry of rawVerification) {
    if (!isPlainObject(entry)) {
      return { error: "policy.verification entries must be objects." };
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      return { error: "policy.verification[].id must be a non-empty string." };
    }
    if (seen.has(entry.id)) {
      return { error: `policy.verification[].id "${entry.id}" is duplicated.` };
    }
    seen.add(entry.id);
    if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
      return { error: `policy.verification["${entry.id}"].argv must be a non-empty array.` };
    }
    if (entry.argv.some((argument) => typeof argument !== "string")) {
      return { error: `policy.verification["${entry.id}"].argv entries must be strings.` };
    }
    const expectedExitCode = entry.expect?.exitCode ?? 0;
    if (!Number.isInteger(expectedExitCode)) {
      return { error: `policy.verification["${entry.id}"].expect.exitCode must be an integer.` };
    }
    verification.push({
      id: entry.id,
      argv: [...entry.argv],
      expect: { exitCode: expectedExitCode },
      required: entry.required !== false
    });
  }
  return { verification };
}

function validateLimits(rawLimits) {
  if (rawLimits === undefined) {
    return { limits: { ...DEFAULT_LIMITS } };
  }
  if (!isPlainObject(rawLimits)) {
    return { error: "policy.limits must be an object." };
  }

  const limits = { ...DEFAULT_LIMITS, ...rawLimits };
  for (const key of ["maxDurationMs", "maxOutputBytes", "maxConcurrentJobs"]) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0) {
      return { error: `policy.limits.${key} must be a positive integer.` };
    }
  }
  if (limits.network !== "off" && limits.network !== "on") {
    return { error: 'policy.limits.network must be "off" or "on".' };
  }
  if (!Array.isArray(limits.envPassthrough) || limits.envPassthrough.some((name) => typeof name !== "string")) {
    return { error: "policy.limits.envPassthrough must be an array of strings." };
  }
  if (
    !Array.isArray(limits.allowedCommands) ||
    limits.allowedCommands.some(
      (argv) => !Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")
    )
  ) {
    return { error: "policy.limits.allowedCommands must be an array of non-empty argv arrays." };
  }
  return {
    limits: {
      ...limits,
      envPassthrough: [...limits.envPassthrough],
      allowedCommands: limits.allowedCommands.map((argv) => [...argv])
    }
  };
}

function validateLanding(rawLanding) {
  if (rawLanding === undefined) {
    return { landing: { ...DEFAULT_LANDING } };
  }
  if (!isPlainObject(rawLanding)) {
    return { error: "policy.landing must be an object." };
  }
  const landing = { ...DEFAULT_LANDING, ...rawLanding };
  if (typeof landing.allowAutoLand !== "boolean" || typeof landing.requireCleanTree !== "boolean") {
    return { error: "policy.landing.allowAutoLand and policy.landing.requireCleanTree must be booleans." };
  }
  return { landing };
}

/**
 * @returns {{ ok: boolean, reason: string | null, policy: object | null }}
 */
export function loadPolicy(repoRoot) {
  const policyPath = resolvePolicyPath(repoRoot);
  if (!fs.existsSync(policyPath)) {
    return invalid(`No policy file at ${POLICY_RELATIVE_PATH}.`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    return invalid(`${POLICY_RELATIVE_PATH} is not valid JSON: ${error.message}`);
  }

  if (!isPlainObject(raw)) {
    return invalid(`${POLICY_RELATIVE_PATH} must contain a JSON object.`);
  }
  if (raw.version !== SUPPORTED_POLICY_VERSION) {
    return invalid(
      `${POLICY_RELATIVE_PATH} declares version ${JSON.stringify(raw.version)}; this plugin supports version ${SUPPORTED_POLICY_VERSION}.`
    );
  }

  const agentResult = validateAgents(raw.agents);
  if (agentResult.error) {
    return invalid(agentResult.error);
  }
  const verificationResult = validateVerification(raw.verification);
  if (verificationResult.error) {
    return invalid(verificationResult.error);
  }
  const limitsResult = validateLimits(raw.limits);
  if (limitsResult.error) {
    return invalid(limitsResult.error);
  }
  const landingResult = validateLanding(raw.landing);
  if (landingResult.error) {
    return invalid(landingResult.error);
  }

  return {
    ok: true,
    reason: null,
    policy: {
      version: SUPPORTED_POLICY_VERSION,
      path: policyPath,
      agents: agentResult.agents,
      verification: verificationResult.verification,
      limits: limitsResult.limits,
      landing: landingResult.landing
    }
  };
}

export function isKnownAgent(agentName) {
  return Object.hasOwn(BUILT_IN_AGENTS, agentName);
}

export function listBuiltInAgents() {
  return Object.keys(BUILT_IN_AGENTS);
}

/**
 * Resolve what an agent is allowed to do. Denials are returned rather than thrown so callers
 * can report the reason verbatim.
 *
 * @returns {{ agent: string, capability: "read" | "write", writableGlobs: string[],
 *             allowed: boolean, reason: string | null, policy: object | null }}
 */
export function resolveAgentCapability(repoRoot, agentName, options = {}) {
  const agent = String(agentName ?? "").trim();
  if (!isKnownAgent(agent)) {
    return {
      agent,
      capability: "read",
      writableGlobs: [],
      allowed: false,
      reason: `Unknown Codex agent "${agent}". Known agents: ${listBuiltInAgents().join(", ")}.`,
      policy: null
    };
  }

  const wantsWrite = options.write ?? BUILT_IN_AGENTS[agent].capability === "write";
  const loaded = options.loadedPolicy ?? loadPolicy(repoRoot);

  if (!wantsWrite) {
    return {
      agent,
      capability: "read",
      writableGlobs: [],
      allowed: true,
      reason: null,
      policy: loaded.ok ? loaded.policy : null
    };
  }

  if (!loaded.ok) {
    return {
      agent,
      capability: "read",
      writableGlobs: [],
      allowed: false,
      reason: `Write execution is denied: ${loaded.reason} Add ${POLICY_RELATIVE_PATH} to enable write-capable Codex agents.`,
      policy: null
    };
  }

  const declared = loaded.policy.agents[agent];
  if (!declared) {
    return {
      agent,
      capability: "read",
      writableGlobs: [],
      allowed: false,
      reason: `Write execution is denied: ${POLICY_RELATIVE_PATH} does not declare an entry for agent "${agent}".`,
      policy: loaded.policy
    };
  }
  if (declared.capability !== "write") {
    return {
      agent,
      capability: "read",
      writableGlobs: [],
      allowed: false,
      reason: `Write execution is denied: ${POLICY_RELATIVE_PATH} declares agent "${agent}" as read-only.`,
      policy: loaded.policy
    };
  }

  return {
    agent,
    capability: "write",
    writableGlobs: [...declared.writableGlobs],
    allowed: true,
    reason: null,
    policy: loaded.policy
  };
}

export { DEFAULT_LIMITS, DEFAULT_LANDING };
