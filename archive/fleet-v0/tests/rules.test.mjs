import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { ContractError } from "../src/contracts.mjs";
import { route } from "../src/router/rules.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const routingRows = [
  {
    name: "risk-critical",
    step: "Audit authentication security across the service.",
    tiers: ["fleet:deep"],
  },
  {
    name: "debug-unknown-root-cause",
    step: "Debug an unexplained failure with an unknown root cause.",
    tiers: ["fleet:codex-high", "fleet:deep"],
  },
  {
    name: "refactor-cross-module",
    step: "Refactor logic across multiple modules.",
    tiers: ["fleet:deep"],
  },
  {
    name: "test-authoring",
    step: "Write tests for the worktree lifecycle.",
    tiers: ["fleet:codex-qa"],
  },
  {
    name: "explore-locate",
    step: "Locate the implementation of run cleanup.",
    tiers: ["fleet:codex-explore"],
  },
  {
    name: "mechanical-single-file-verifiable",
    step: "Mechanically rename one file with a verifiable command check.",
    tiers: ["fleet:quick"],
  },
  {
    name: "implement-large",
    step: "Implement a large new module for scheduling.",
    tiers: ["fleet:codex-high"],
  },
  {
    name: "implement-small",
    step: "Implement a small change in two files.",
    tiers: ["fleet:codex-low"],
  },
  {
    name: "implement-medium",
    step: "Implement request routing behavior.",
    tiers: ["fleet:standard"],
  },
  {
    name: "default-standard",
    step: "Refactor one local helper.",
    tiers: ["fleet:standard"],
  },
];

test("route covers every policy row with its best-fit Tier", () => {
  // Given: one representative Step for every routing-table row.
  const cases = routingRows;

  // When: Fleet routes each Step.
  const decisions = cases.map(({ step }) => route(step));

  // Then: each named rule selects exactly its declared Tier set.
  assert.deepEqual(
    decisions.map((decision) => ({
      name: decision.rule,
      tiers: decision.tiers.map(({ tier }) => tier),
    })),
    cases.map(({ name, tiers }) => ({ name, tiers })),
  );
});

test("route treats all critical-risk kinds as the same xhigh rule", () => {
  // Given: security, concurrency, and migration Steps.
  const steps = [
    "Audit security permissions.",
    "Fix a concurrency race condition.",
    "Migrate the database schema.",
  ];

  // When: Fleet routes each critical-risk Step.
  const decisions = steps.map((step) => route(step));

  // Then: every Step selects the xhigh deep Tier.
  assert.deepEqual(
    decisions.map(({ rule, effort }) => ({ rule, effort })),
    steps.map(() => ({ rule: "risk-critical", effort: "xhigh" })),
  );
});

test("route is total for valid non-specialized Step shapes", () => {
  // Given: valid shapes that do not satisfy a specialized policy row.
  const steps = [
    "Debug a failure with a known root cause.",
    "Refactor one local helper.",
    "Mechanically rename one file without a command criterion.",
  ];

  // When: Fleet routes each Step.
  const decisions = steps.map((step) => route(step));

  // Then: the explicit default rule selects the standard Tier.
  assert.deepEqual(
    decisions.map(({ rule, tier }) => ({ rule, tier })),
    steps.map(() => ({ rule: "default-standard", tier: "fleet:standard" })),
  );
});

test("route infers a named single-file rename with a test command as verifiable", () => {
  // Given: the representative prompt shape emitted by an ambient Task spawn.
  const step = "Rename one local constant in src/example.mjs and run its test.";

  // When: Fleet routes the prompt text without structured Plan metadata.
  const decision = route(step);

  // Then: the mechanical single-file rule selects the quick Tier.
  assert.equal(decision.rule, "mechanical-single-file-verifiable");
  assert.equal(decision.tier, "fleet:quick");
});

test("route is deterministic and does not consult clock, randomness, or network", () => {
  // Given: forbidden clock, random, and network functions plus stable inputs.
  const originalNow = Date.now;
  const originalRandom = Math.random;
  const originalFetch = globalThis.fetch;
  Date.now = () => {
    throw new Error("route consulted the clock");
  };
  Math.random = () => {
    throw new Error("route consulted randomness");
  };
  globalThis.fetch = () => {
    throw new Error("route consulted the network");
  };

  try {
    // When: the same Step is routed twice.
    const first = route(
      { intent: "Implement a small parser.", files: ["src/parser.mjs"] },
      { codexAvailable: true, claudeAvailable: true },
      { codexActive: 1, codexCapacity: 3 },
    );
    const second = route(
      { intent: "Implement a small parser.", files: ["src/parser.mjs"] },
      { codexAvailable: true, claudeAvailable: true },
      { codexActive: 1, codexCapacity: 3 },
    );

    // Then: the complete Route values are equal.
    assert.deepEqual(first, second);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("route rejects invalid boundary inputs", () => {
  // Given: invalid Step, quota, and pool-state values.
  const invalidCalls = [
    () => route(""),
    () => route("Implement routing.", { codexAvailable: true }),
    () => route(
      "Implement routing.",
      { codexAvailable: true, claudeAvailable: true },
      { codexActive: 4, codexCapacity: 3 },
    ),
  ];

  // When/Then: every invalid boundary is rejected by the runtime contract.
  invalidCalls.forEach((call) => assert.throws(call, ContractError));
});

test("route degrades an unavailable Codex best-fit to Claude and names the intended Tier", () => {
  const decision = route(
    {
      intent: "Implement a small parser.",
      files: ["src/parser.mjs"],
      kind: "implement",
      size: "small",
    },
    { codexAvailable: false, claudeAvailable: true },
  );

  assert.equal(decision.provider, "claude");
  assert.equal(decision.tier, "fleet:quick");
  assert.equal(decision.effort, "low");
  assert.equal(decision.degraded, true);
  assert.equal(decision.intendedTier, "fleet:codex-low");
});

test("route refuses to silently drop work when neither provider is available", () => {
  assert.throws(
    () =>
      route(
        "Implement request routing behavior.",
        { codexAvailable: false, claudeAvailable: false },
      ),
    /provider.*available/i,
  );
});

test("route --explain names the firing rule for every policy row", () => {
  // Given: representative CLI text for every policy row.
  const cases = routingRows;

  // When: each Step is routed through the public CLI.
  const results = cases.map(({ step }) =>
    spawnSync(
      process.execPath,
      ["src/cli.mjs", "route", step, "--explain"],
      { cwd: repoRoot, encoding: "utf8" },
    ));

  // Then: each command succeeds and names its firing rule.
  results.forEach((result, index) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^Rule: ${cases[index].name}$`, "m"));
  });
});
