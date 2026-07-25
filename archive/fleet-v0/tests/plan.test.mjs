import assert from "node:assert/strict";
import test from "node:test";

import {
  PlanError,
  digestPlan,
  parsePlan,
  resolveCriterionOutcome,
  serializePlan,
} from "../src/fleet/plan.mjs";

const commandPlan = `# Fleet Plan

Intent: Add plan validation.

## Step schema
Intent: Validate Fleet plan contracts.
Dependencies: none
Files: src/fleet/plan.mjs, tests/plan.test.mjs
Check Kind: command
Command: node --test tests/plan.test.mjs
Expected: exit code 0
`;

test("parsePlan returns a command-checked Plan", () => {
  // Given: a Plan with a machine-checkable command criterion.
  const markdown = commandPlan;

  // When: Fleet parses the Plan contract.
  const plan = parsePlan(markdown);

  // Then: the Step retains its declared ownership and executable criterion.
  assert.deepEqual(plan, {
    intent: "Add plan validation.",
    steps: [{
      id: "schema",
      intent: "Validate Fleet plan contracts.",
      dependencies: [],
      files: ["src/fleet/plan.mjs", "tests/plan.test.mjs"],
      checkKind: "command",
      criteria: {
        command: "node --test tests/plan.test.mjs",
        expected: "exit code 0",
      },
    }],
  });
});

test("parsePlan accepts an explicit review criterion", () => {
  // Given: a Plan Step that needs a human judgement instead of an executable check.
  const markdown = `# Fleet Plan
Intent: Review a visual change.
## Step inspect
Intent: Compare the rendered change against the design.
Dependencies: none
Files: docs/mockup.png
Check Kind: review
Review: Compare the rendered change against the approved design.
`;

  // When: Fleet parses the Plan contract.
  const plan = parsePlan(markdown);

  // Then: review stays an explicit second-class check kind.
  assert.deepEqual(plan.steps[0].criteria, {
    review: "Compare the rendered change against the approved design.",
  });
  assert.equal(plan.steps[0].checkKind, "review");
});

test("parsePlan rejects a prose criterion", () => {
  // Given: a Plan that substitutes prose for a machine-checkable criterion.
  const markdown = `# Fleet Plan
Intent: Change a setting.
## Step config
Intent: Set the timeout.
Dependencies: none
Files: config.json
Criteria: The timeout looks correct.
`;

  // When: Fleet parses the Plan contract.
  const parsing = () => parsePlan(markdown);

  // Then: no uncheckable prose enters the execution lifecycle.
  assert.throws(parsing, PlanError);
});

test("resolveCriterionOutcome never passes unchecked or review criteria", () => {
  // Given: attempted pass results for unchecked, review, and checked command criteria.
  const unchecked = {
    checkKind: "command",
    checked: false,
    outcome: "pass",
  };
  const reviewed = {
    checkKind: "review",
    checked: true,
    outcome: "pass",
  };
  const checked = {
    checkKind: "command",
    checked: true,
    outcome: "pass",
  };

  // When: Fleet records the criterion outcomes.
  const uncheckedOutcome = resolveCriterionOutcome(unchecked);
  const reviewOutcome = resolveCriterionOutcome(reviewed);
  const checkedOutcome = resolveCriterionOutcome(checked);

  // Then: only the objectively checked command passes.
  assert.equal(uncheckedOutcome, "unverified");
  assert.equal(reviewOutcome, "unverified");
  assert.equal(checkedOutcome, "pass");
});

test("serializePlan preserves a valid Plan contract", () => {
  // Given: a parsed Plan contract.
  const plan = parsePlan(commandPlan);

  // When: Fleet serializes and parses the contract again.
  const reparsed = parsePlan(serializePlan(plan));

  // Then: the machine-readable Plan is unchanged.
  assert.deepEqual(reparsed, plan);
});

test("digestPlan binds approval to the exact Markdown bytes", () => {
  assert.equal(digestPlan(commandPlan), digestPlan(commandPlan));
  assert.notEqual(digestPlan(commandPlan), digestPlan(`${commandPlan}\n`));
});
