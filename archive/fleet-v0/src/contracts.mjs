const STEP_KINDS = new Set([
  "concurrency",
  "debug",
  "explore",
  "implement",
  "mechanical",
  "migration",
  "refactor",
  "security",
  "test",
]);
const STEP_SIZES = new Set(["small", "medium", "large"]);
const CHECK_KINDS = new Set(["command", "review"]);
const PROVIDERS = new Set(["claude", "codex"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export const DEFAULT_QUOTA = Object.freeze({
  codexAvailable: true,
  claudeAvailable: true,
});

export const DEFAULT_POOL_STATE = Object.freeze({
  codexActive: 0,
  codexCapacity: 3,
});

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object.`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ContractError(`${label} must be a boolean.`);
  }
  return value;
}

function enumValue(value, values, label) {
  if (value !== undefined && !values.has(value)) {
    throw new ContractError(`${label} is invalid.`);
  }
  return value;
}

function stringArray(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ContractError(`${label} must be an array.`);
  }
  return value.map((entry) => nonEmptyString(entry, `${label} entry`));
}

export function parseRoutingStep(value) {
  if (typeof value === "string") {
    return { intent: nonEmptyString(value, "Step intent"), files: [] };
  }
  const input = record(value, "Step");
  return {
    intent: nonEmptyString(input.intent, "Step intent"),
    files: stringArray(input.files, "Step files"),
    kind: enumValue(input.kind, STEP_KINDS, "Step kind"),
    size: enumValue(input.size, STEP_SIZES, "Step size"),
    checkKind: enumValue(input.checkKind, CHECK_KINDS, "Step check kind"),
    verifiable: optionalBoolean(input.verifiable, "Step verifiable"),
    crossModule: optionalBoolean(input.crossModule, "Step crossModule"),
    newModule: optionalBoolean(input.newModule, "Step newModule"),
    unknownRootCause: optionalBoolean(
      input.unknownRootCause,
      "Step unknownRootCause",
    ),
  };
}

export function parseQuota(value = DEFAULT_QUOTA) {
  const input = record(value, "Quota");
  if (
    typeof input.codexAvailable !== "boolean" ||
    typeof input.claudeAvailable !== "boolean"
  ) {
    throw new ContractError(
      "Quota requires boolean codexAvailable and claudeAvailable fields.",
    );
  }
  return {
    codexAvailable: input.codexAvailable,
    claudeAvailable: input.claudeAvailable,
  };
}

export function parsePoolState(value = DEFAULT_POOL_STATE) {
  const input = record(value, "Pool state");
  if (
    !Number.isInteger(input.codexActive) ||
    input.codexActive < 0 ||
    !Number.isInteger(input.codexCapacity) ||
    input.codexCapacity < 1 ||
    input.codexActive > input.codexCapacity
  ) {
    throw new ContractError(
      "Pool state requires a valid codexActive/codexCapacity pair.",
    );
  }
  return {
    codexActive: input.codexActive,
    codexCapacity: input.codexCapacity,
  };
}

export function parsePolicy(value) {
  const input = record(value, "Policy");
  if (input.version !== 1 || !Array.isArray(input.rules) || input.rules.length === 0) {
    throw new ContractError("Policy must contain version 1 and at least one rule.");
  }
  const names = new Set();
  const rules = input.rules.map((rawRule) => {
    const rule = record(rawRule, "Policy rule");
    const name = nonEmptyString(rule.name, "Policy rule name");
    if (names.has(name)) {
      throw new ContractError(`Policy rule name is duplicated: ${name}.`);
    }
    names.add(name);
    const when = record(rule.when, `Policy rule ${name} condition`);
    if (!Array.isArray(rule.tiers) || rule.tiers.length === 0) {
      throw new ContractError(`Policy rule ${name} requires at least one tier.`);
    }
    const tiers = rule.tiers.map((rawTier) => {
      const tier = record(rawTier, `Policy rule ${name} tier`);
      return {
        tier: nonEmptyString(tier.tier, `Policy rule ${name} tier name`),
        provider: enumValue(
          tier.provider,
          PROVIDERS,
          `Policy rule ${name} provider`,
        ),
        effort: enumValue(
          tier.effort,
          EFFORTS,
          `Policy rule ${name} effort`,
        ),
      };
    });
    return { name, when: { ...when }, tiers };
  });
  return { version: 1, rules };
}
