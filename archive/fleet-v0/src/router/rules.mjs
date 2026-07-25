import policyJson from "../../policy.json" with { type: "json" };

import {
  DEFAULT_POOL_STATE,
  DEFAULT_QUOTA,
  parsePolicy,
  parsePoolState,
  parseQuota,
} from "../contracts.mjs";
import { extractFeatures } from "./features.mjs";

export const policy = parsePolicy(policyJson);

function matchesValue(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function matches(shape, condition) {
  return Object.entries(condition).every(([field, expected]) => {
    if (field === "fileCountMax") {
      return shape.fileCount <= expected;
    }
    if (field === "fileCountMin") {
      return shape.fileCount >= expected;
    }
    return matchesValue(shape[field], expected);
  });
}

function providerAvailable(provider, quota) {
  return provider === "codex" ? quota.codexAvailable : quota.claudeAvailable;
}

function fallbackTier(provider, effort) {
  if (provider === "claude") {
    return {
      provider,
      tier:
        effort === "low"
          ? "fleet:quick"
          : effort === "medium"
            ? "fleet:standard"
            : "fleet:deep",
      effort,
    };
  }
  return {
    provider,
    tier: effort === "low" ? "fleet:codex-low" : "fleet:codex-high",
    effort,
  };
}

export function applyQuota(decision, quota = DEFAULT_QUOTA) {
  const available = parseQuota(quota);
  if (!available.codexAvailable && !available.claudeAvailable) {
    throw new Error("No Fleet provider is available for this Step.");
  }
  if (providerAvailable(decision.provider, available)) {
    return decision;
  }
  const selected =
    decision.tiers?.find((tier) => providerAvailable(tier.provider, available)) ??
    fallbackTier(
      decision.provider === "codex" ? "claude" : "codex",
      decision.effort,
    );
  return {
    ...decision,
    tier: selected.tier,
    provider: selected.provider,
    effort: selected.effort,
    degraded: true,
    intendedTier: decision.tier,
  };
}

export function route(
  step,
  quota = DEFAULT_QUOTA,
  poolState = DEFAULT_POOL_STATE,
) {
  const shape = extractFeatures(step);
  parsePoolState(poolState);
  const rule = policy.rules.find((candidate) => matches(shape, candidate.when));
  if (rule === undefined) {
    throw new Error(`No Fleet routing rule matches shape ${JSON.stringify(shape)}.`);
  }
  const tiers = rule.tiers.map((tier) => ({ ...tier }));
  const primary = tiers[0];
  return applyQuota({
    shape,
    rule: rule.name,
    tier: primary.tier,
    tiers,
    provider: primary.provider,
    effort: primary.effort,
    degraded: false,
    intendedTier: null,
  }, quota);
}
