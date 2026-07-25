import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_DEFINITIONS,
  createFleetMcpServer,
} from "../src/mcp/server.mjs";
import { digestPlan } from "../src/fleet/plan.mjs";
import { createCodexPool } from "../src/fleet/pool.mjs";

const APPROVED_PLAN = `# Fleet Plan
Intent: test forwarding

## Step step-c
Intent: edit the target
Dependencies: none
Files: target.txt
Check Kind: command
Command: node --test
Expected: exits 0

## Step step-a
Intent: refactor the companion files across multiple modules
Dependencies: none
Files: src/companion.mjs, tests/companion.test.mjs
Check Kind: review
Review: diff matches the intent

## Step step-c2
Intent: edit the second target
Dependencies: none
Files: second-target.txt
Check Kind: command
Command: node --test
Expected: exits 0

## Step step-overlap
Intent: edit the target differently
Dependencies: none
Files: target.txt
Check Kind: command
Command: node --test
Expected: exits 0

## Step step-dependent
Intent: edit after the target
Dependencies: step-c
Files: dependent.txt
Check Kind: command
Command: node --test
Expected: exits 0
`;

function createHarness(overrides = {}) {
  const events = [];
  const codexInputs = [];
  const createRunInputs = [];
  const childGenerations = new Map();
  const run = {
    runId: "run-123",
    state: "created",
    repoRoot: "/tmp/target",
    worktreePath: "/tmp/worktree",
    eventsPath: "/tmp/worktree/.fleet/run-123/events.jsonl",
    planPath: "/tmp/worktree/.fleet/run-123/plan.md",
    planDigest: digestPlan(APPROVED_PLAN),
  };
  return {
    events,
    codexInputs,
    createRunInputs,
    server: createFleetMcpServer({
      fleetRoot: "/opt/fleet",
      createRun: async (input) => {
        createRunInputs.push(input);
        return run;
      },
      getRunStatus: (runId) => (runId === run.runId ? run : null),
      getRunDiff: async () => "diff --git",
      getWorktreeDiff: async () => "diff --git child",
      appendEvent: async (_path, event) => events.push(event),
      readEvents: async () => events,
      readPlan: async () => APPROVED_PLAN,
      evaluateCriterion: async ({ step }) => ({
        outcome: step.checkKind === "review" ? "unverified" : "pass",
        expected:
          step.checkKind === "command" ? step.criteria.expected : null,
        failureEvidence: null,
      }),
      resetRunWorktree: async () => ({
        diffBefore: "diff --git",
        diffAfter: "",
      }),
      runCodexStep: async (input) => {
        codexInputs.push(input);
        return { finalResponse: "done", usage: { input_tokens: 1 } };
      },
      codexPool: createCodexPool(3),
      createStepWorktree: async ({ stepId }) => {
        const generation = (childGenerations.get(stepId) ?? 0) + 1;
        childGenerations.set(stepId, generation);
        return {
          repoPath: run.repoRoot,
          runId: run.runId,
          stepId,
          branch: `fleet/${run.runId}-step-${stepId}`,
          worktreePath: `${run.worktreePath}-${stepId}-${generation}`,
          ownedRoot: "/tmp",
        };
      },
      recoverStepWorktree: async () => null,
      findStepWorktree: async () => null,
      cleanupStepWorktreeLeftover: async () => false,
      mergeStepWorktree: async ({ child }) => ({
        changedFiles: [child.stepId === "step-c" ? "target.txt" : "second-target.txt"],
        diff: `diff ${child.stepId}`,
      }),
      discardStepWorktree: async () => ({
        diffBefore: "diff --git",
        diffAfter: "",
      }),
      ...overrides,
    }),
  };
}

function restartedServer(events, overrides = {}) {
  return createHarness({
    readEvents: async () => events,
    appendEvent: async (_path, event) => events.push(event),
    ...overrides,
  }).server;
}

const failedCriterion = async ({ step }) => ({
  outcome: "fail",
  expected: step.criteria.expected,
  failureEvidence: { stderr: `failed ${step.id}` },
});

async function awaitForwarded(server, forwarded) {
  return server.callTool("await", {
    runId: forwarded.runId,
    stepId: forwarded.stepId,
    rung: forwarded.rung,
  });
}

function routeEvents(events) {
  return events.filter((event) => event.eventKind !== "finalization");
}

test("lists the Stage 4 route, run-control, and criterion tools", async () => {
  // Given
  const { server } = createHarness();

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  // Then
  assert.deepEqual(
    response.result.tools.map(({ name }) => name),
    ["forward", "route", "await", "status", "check"],
  );
  assert.deepEqual(
    TOOL_DEFINITIONS.map(({ name }) => name),
    ["forward", "route", "await", "status", "check"],
  );
  assert.deepEqual(
    TOOL_DEFINITIONS[0].inputSchema.properties.provider.enum,
    ["codex", "claude"],
  );
  assert.deepEqual(
    TOOL_DEFINITIONS.find(({ name }) => name === "await").inputSchema.required,
    ["runId", "stepId", "rung"],
  );
});

test("Codex-first forward persists the approved Plan and records its actual Route", async () => {
  // Given
  const { server, codexInputs, createRunInputs, events } = createHarness();

  // When
  const forwarded = await server.callTool("forward", {
    repoPath: "/tmp/target",
    provider: "codex",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  const completed = await awaitForwarded(server, forwarded);
  assert.equal(events.length, 0);
  const checked = await server.callTool("check", {
    runId: forwarded.runId,
    stepId: "step-c",
    rung: 1,
  });

  // Then
  assert.equal(forwarded.status, "running");
  assert.equal(forwarded.planPath, runPlanPath());
  assert.equal(createRunInputs[0].planMarkdown, APPROVED_PLAN);
  assert.deepEqual(codexInputs, [
    {
      repoRoot: "/opt/fleet",
      workingDirectory: "/tmp/worktree-step-c-1",
      prompt: "edit the target",
      modelReasoningEffort: "low",
    },
  ]);
  assert.equal(completed.status, "completed");
  assert.equal(checked.outcome, "pass");
  assert.equal(completed.diff, "diff --git child");
  const [event] = routeEvents(events);
  assert.equal(event.provider, "codex");
  assert.equal(event.tier, "fleet:codex-low");
  assert.equal(event.effort, "low");
  assert.equal(event.rule, "implement-small");
  assert.deepEqual(event.shape, {
    kind: "implement",
    size: "small",
    fileCount: 1,
    verifiable: true,
    crossModule: false,
    newModule: false,
    unknownRootCause: false,
  });
  assert.equal(event.degraded, false);
  assert.equal(event.intendedTier, null);
  assert.equal(event.outcome, "pass");
  assert.equal(event.criteria, "node --test");
  assert.equal(event.checkKind, "command");
  assert.equal(typeof event.startedAt, "string");
  assert.equal(typeof event.completedAt, "string");
  assert.equal(event.attemptWorktreePath, "/tmp/worktree-step-c-1");
});

test("forward honors an explicit Fleet Codex home", async () => {
  // Given
  const { server, codexInputs } = createHarness({
    codexHome: "/var/lib/fleet/codex-home",
  });

  // When
  const forwarded = await server.callTool("forward", {
    repoPath: "/tmp/target",
    provider: "codex",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, forwarded);

  // Then
  assert.equal(codexInputs[0].codexHome, "/var/lib/fleet/codex-home");
});

test("Claude-first forward creates a Run and uses the actual routed native tier", async () => {
  // Given
  const { server, codexInputs, events } = createHarness();

  // When
  const started = await server.callTool("forward", {
    repoPath: "/tmp/target",
    provider: "claude",
    intent: "refactor the companion files across multiple modules",
    stepId: "step-a",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await server.callTool("check", {
    runId: started.runId,
    stepId: "step-a",
    rung: 1,
  });
  const forwarded = await server.callTool("forward", {
    runId: "run-123",
    provider: "codex",
    intent: "edit the target",
    stepId: "step-c",
  });
  await awaitForwarded(server, forwarded);
  await server.callTool("check", {
    runId: forwarded.runId,
    stepId: "step-c",
    rung: 1,
  });

  // Then
  assert.equal(started.status, "ready");
  assert.equal(started.planPath, runPlanPath());
  assert.equal(started.nativeAgent.subagentType, "fleet:deep");
  assert.equal(started.nativeAgent.effort, "high");
  assert.equal(started.nativeAgent.worktreePath, "/tmp/worktree-step-a-1");
  assert.match(started.nativeAgent.prompt, /<fleet-route approved="true">/);
  assert.match(started.nativeAgent.prompt, /fleet:deep at high effort/);
  assert.equal(codexInputs.length, 1);
  const routes = routeEvents(events);
  assert.equal(routes[0].provider, "claude");
  assert.equal(routes[0].tier, "fleet:deep");
  assert.equal(routes[0].rule, "refactor-cross-module");
  assert.equal(routes[0].outcome, "unverified");
  assert.equal(routes[0].criteria, "diff matches the intent");
  assert.equal(routes[0].checkKind, "review");
  assert.equal(routes[1].provider, "codex");
});

test("a restarted handler reloads the approved Plan before routing a Claude Step", async () => {
  // Given: an existing Run whose approved Plan is persisted on disk.
  const { server, events } = createHarness();

  // When: the fresh handler receives the second Step after an MCP restart.
  const forwarded = await server.callTool("route", {
    runId: "run-123",
    intent: "refactor the companion files across multiple modules",
    stepId: "step-a",
  });

  // Then: the persisted approval contract authorizes only the matching Step.
  assert.equal(forwarded.provider, "claude");
  assert.equal(forwarded.tier, "fleet:deep");
  assert.equal(events.length, 0);
});

test("a restarted handler resumes rung 2 from the durable rung 1 Event", async () => {
  // Given
  const { server, events } = createHarness({
    evaluateCriterion: failedCriterion,
  });
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, first);
  await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 1,
  });

  // When
  const resumed = await restartedServer(events).callTool("forward", {
    runId: first.runId,
    provider: "codex",
    intent: "edit the target",
    stepId: "step-c",
  });

  // Then
  assert.equal(resumed.rung, 2);
  assert.equal(resumed.tier, "fleet:codex-high");
  assert.equal(resumed.effort, "high");
});

test("restart reapplies current quota before resuming a recovered ladder route", async () => {
  // Given
  const { server, events } = createHarness({
    getQuota: () => ({ codexAvailable: true, claudeAvailable: true }),
    evaluateCriterion: failedCriterion,
  });
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, first);
  await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 1,
  });

  // When
  const restarted = restartedServer(events, {
    getQuota: () => ({ codexAvailable: false, claudeAvailable: true }),
  });
  const resumed = await restarted.callTool("forward", {
    runId: first.runId,
    intent: "edit the target",
    stepId: "step-c",
  });

  // Then
  assert.equal(resumed.rung, 2);
  assert.equal(resumed.provider, "claude");
  assert.equal(resumed.tier, "fleet:deep");
  await restarted.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 2,
  });
  const recoveredEvent = routeEvents(events).at(-1);
  assert.equal(recoveredEvent.degraded, true);
  assert.equal(recoveredEvent.intendedTier, "fleet:codex-high");
});

test("a restarted handler resumes fresh cross-provider rung 3 after reset", async () => {
  // Given
  const { server, events } = createHarness({
    evaluateCriterion: failedCriterion,
  });
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, first);
  const firstCheck = await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 1,
  });
  const second = await server.callTool("forward", {
    runId: first.runId,
    provider: firstCheck.nextRoute.provider,
    intent: "edit the target",
    stepId: "step-c",
  });
  await awaitForwarded(server, second);
  await server.callTool("check", {
    runId: second.runId,
    stepId: "step-c",
    rung: 2,
  });

  // When
  const resumed = await restartedServer(events).callTool("forward", {
    runId: second.runId,
    provider: "claude",
    intent: "edit the target",
    stepId: "step-c",
  });
  // Then
  assert.equal(resumed.rung, 3);
  assert.equal(resumed.tier, "fleet:deep");
  assert.equal(resumed.effort, "high");
});

test("a restarted handler cannot exceed a durable rung 3 halt", async () => {
  // Given
  const { server, events } = createHarness({
    evaluateCriterion: failedCriterion,
  });
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, first);
  const firstCheck = await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 1,
  });
  const second = await server.callTool("forward", {
    runId: first.runId,
    provider: firstCheck.nextRoute.provider,
    intent: "edit the target",
    stepId: "step-c",
  });
  await awaitForwarded(server, second);
  const secondCheck = await server.callTool("check", {
    runId: second.runId,
    stepId: "step-c",
    rung: 2,
  });
  const third = await server.callTool("forward", {
    runId: second.runId,
    provider: secondCheck.nextRoute.provider,
    intent: "edit the target",
    stepId: "step-c",
  });
  await server.callTool("check", {
    runId: third.runId,
    stepId: "step-c",
    rung: 3,
  });

  // When / Then
  await assert.rejects(
    restartedServer(events).callTool("forward", {
      runId: third.runId,
      intent: "edit the target",
      stepId: "step-c",
    }),
    /terminal/,
  );
  assert.equal(routeEvents(events).length, 3);
});

test("restart reconciles terminal pass before releasing a dependent Step", async () => {
  // Given
  const events = [{
    runId: "run-123",
    stepId: "step-c",
    rung: 1,
    outcome: "pass",
    attemptWorktreePath: "/tmp/worktree-step-c-crashed",
  }];
  const order = [];
  const server = restartedServer(events, {
    recoverStepWorktree: async () => ({ worktreePath: "/tmp/worktree-step-c-crashed" }),
    mergeStepWorktree: async () => {
      order.push("merge");
      return { changedFiles: ["target.txt"], diff: "diff", replayed: false };
    },
    createStepWorktree: async ({ stepId }) => {
      order.push(`create:${stepId}`);
      return {
        stepId,
        worktreePath: `/tmp/${stepId}`,
      };
    },
  });

  // When
  await server.callTool("forward", {
    runId: "run-123",
    intent: "edit after the target",
    stepId: "step-dependent",
  });

  // Then
  assert.deepEqual(order.slice(0, 2), ["merge", "create:step-dependent"]);
});

test("restart discards a rung 2 child before creating fresh rung 3", async () => {
  // Given
  const events = [
    {
      runId: "run-123",
      stepId: "step-c",
      rung: 1,
      outcome: "fail",
      provider: "codex",
      tier: "fleet:codex-low",
      effort: "low",
    },
    {
      runId: "run-123",
      stepId: "step-c",
      rung: 2,
      outcome: "fail",
      provider: "codex",
      tier: "fleet:codex-high",
      effort: "high",
      attemptWorktreePath: "/tmp/worktree-step-c-rung2",
    },
  ];
  const order = [];
  const server = restartedServer(events, {
    recoverStepWorktree: async () => ({ worktreePath: "/tmp/worktree-step-c-rung2" }),
    discardStepWorktree: async () => {
      order.push("discard");
      return { diffBefore: "dirty", diffAfter: "" };
    },
    createStepWorktree: async ({ stepId }) => {
      order.push("create");
      return { stepId, worktreePath: "/tmp/worktree-step-c-rung3" };
    },
  });

  // When
  const third = await server.callTool("forward", {
    runId: "run-123",
    provider: "claude",
    intent: "edit the target",
    stepId: "step-c",
  });

  // Then
  assert.deepEqual(order, ["discard", "create"]);
  assert.equal(third.rung, 3);
  assert.equal(third.worktreePath, "/tmp/worktree-step-c-rung3");
});

test("restart cleans a halted child before rejecting another forward", async () => {
  // Given
  const events = [
    {
      runId: "run-123",
      stepId: "step-c",
      rung: 1,
      outcome: "fail",
      provider: "codex",
      tier: "fleet:codex-low",
      effort: "low",
    },
    {
      runId: "run-123",
      stepId: "step-c",
      rung: 2,
      outcome: "fail",
      provider: "codex",
      tier: "fleet:codex-high",
      effort: "high",
    },
    {
      runId: "run-123",
      stepId: "step-c",
      rung: 3,
      outcome: "halt",
      provider: "claude",
      tier: "fleet:deep",
      effort: "high",
      attemptWorktreePath: "/tmp/worktree-step-c-halt",
    },
  ];
  let discarded = false;
  const server = restartedServer(events, {
    recoverStepWorktree: async () => ({ worktreePath: "/tmp/worktree-step-c-halt" }),
    discardStepWorktree: async () => {
      discarded = true;
      return { diffBefore: "dirty", diffAfter: "" };
    },
  });

  // When / Then
  await assert.rejects(
    server.callTool("forward", {
      runId: "run-123",
      intent: "edit the target",
      stepId: "step-c",
    }),
    /terminal/,
  );
  assert.equal(discarded, true);
});

test("restarted status reconstructs durable scheduler state", async () => {
  // Given
  const events = [{
    runId: "run-123",
    stepId: "step-c",
    rung: 1,
    outcome: "pass",
    attemptWorktreePath: "/tmp/worktree-step-c-finished",
  }];
  const server = restartedServer(events, {
    recoverStepWorktree: async () => null,
  });

  // When
  const status = await server.callTool("status", { runId: "run-123" });

  // Then
  assert.equal(status.scheduler.steps["step-c"].state, "pass");
  assert.notEqual(status.scheduler, null);
});

test("restart labels and reuses an unevaluated deterministic child", async () => {
  // Given
  const child = {
    stepId: "step-c",
    worktreePath: "/tmp/worktree-step-c-inflight",
  };
  let createCalls = 0;
  const server = restartedServer([], {
    findStepWorktree: async ({ stepId }) =>
      stepId === "step-c" ? child : null,
    createStepWorktree: async () => {
      createCalls += 1;
      throw new Error("must reuse recovered child");
    },
  });

  // When
  const status = await server.callTool("status", { runId: "run-123" });
  const forwarded = await server.callTool("forward", {
    runId: "run-123",
    intent: "edit the target",
    stepId: "step-c",
  });

  // Then
  assert.equal(status.attempts[0].state, "unknown-in-flight");
  assert.equal(status.attempts[0].worktreePath, child.worktreePath);
  assert.equal(forwarded.worktreePath, child.worktreePath);
  assert.equal(createCalls, 0);
});

test("a restarted handler rejects a modified persisted Plan", async () => {
  // Given: a worker changed plan.md after the user approved it.
  const { server, events } = createHarness({
    readPlan: async () => APPROVED_PLAN.replace(
      "refactor the companion files across multiple modules",
      "run an unapproved command",
    ),
  });

  // When: a fresh handler tries to reload the mutable worktree copy.
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "forward",
      arguments: {
        runId: "run-123",
        intent: "refactor the companion files across multiple modules",
        stepId: "step-a",
      },
    },
  });

  // Then: digest mismatch blocks execution before an Event is written.
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /approved digest/);
  assert.equal(events.length, 0);
});

function runPlanPath() {
  return "/tmp/worktree/.fleet/run-123/plan.md";
}

test("returns an actionable tool error for an unknown Run", async () => {
  // Given
  const { server } = createHarness();

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "status", arguments: { runId: "missing" } },
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /forward/i);
});

test("refuses to create a Run before Plan approval", async () => {
  // Given
  const { server, codexInputs } = createHarness();

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "forward",
      arguments: {
        repoPath: "/tmp/target",
        provider: "codex",
        intent: "edit the target",
        stepId: "step-c",
        plan: APPROVED_PLAN,
      },
    },
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /approval/i);
  assert.equal(codexInputs.length, 0);
});

test("route requires explicit approval before a Run exists", async () => {
  // Given
  const { server } = createHarness();

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "route",
      arguments: {
        plan: APPROVED_PLAN,
        intent: "edit the target",
        stepId: "step-c",
      },
    },
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /approval/i);
});

test("route resolves an approved Plan Step without creating a Run", async () => {
  // Given
  const { server, createRunInputs } = createHarness();

  // When
  const resolved = await server.callTool("route", {
    plan: APPROVED_PLAN,
    approved: true,
    intent: "edit the target",
    stepId: "step-c",
  });

  // Then
  assert.equal(resolved.provider, "codex");
  assert.equal(resolved.tier, "fleet:codex-low");
  assert.equal(resolved.effort, "low");
  assert.equal(createRunInputs.length, 0);
});

test("quota-degraded execution surfaces reset credits and logs its intended Tier", async () => {
  const { server, events } = createHarness({
    getQuota: () => ({
      capturedAt: "2026-07-25T00:00:00.000Z",
      codexAvailable: false,
      resetCredits: { availableCount: 2 },
    }),
  });

  const resolved = await server.callTool("route", {
    plan: APPROVED_PLAN,
    approved: true,
    intent: "edit the target",
    stepId: "step-c",
  });
  const forwarded = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await server.callTool("check", {
    runId: forwarded.runId,
    stepId: "step-c",
    rung: 1,
  });

  assert.equal(resolved.provider, "claude");
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.intendedTier, "fleet:codex-low");
  assert.equal(resolved.resetCredits.availableCount, 2);
  assert.equal(forwarded.provider, "claude");
  assert.equal(routeEvents(events)[0].degraded, true);
  assert.equal(routeEvents(events)[0].intendedTier, "fleet:codex-low");
});

test("a quota update degrades the next ladder rung before it is forwarded", async () => {
  let codexAvailable = true;
  const { server, events } = createHarness({
    getQuota: () => ({ codexAvailable }),
    evaluateCriterion: failedCriterion,
  });

  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  await awaitForwarded(server, first);
  codexAvailable = false;
  const failed = await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 1,
  });
  const second = await server.callTool("forward", {
    runId: first.runId,
    intent: "edit the target",
    stepId: "step-c",
  });
  await server.callTool("check", {
    runId: first.runId,
    stepId: "step-c",
    rung: 2,
  });

  assert.equal(failed.nextRoute.provider, "claude");
  assert.equal(failed.nextRoute.tier, "fleet:deep");
  assert.equal(second.provider, "claude");
  assert.equal(routeEvents(events)[1].degraded, true);
  assert.equal(routeEvents(events)[1].intendedTier, "fleet:codex-high");
});

test("forward rejects a caller provider that mismatches the actual Route", async () => {
  // Given
  const { server, codexInputs } = createHarness();

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "forward",
      arguments: {
        repoPath: "/tmp/target",
        provider: "claude",
        intent: "edit the target",
        stepId: "step-c",
        plan: APPROVED_PLAN,
        approved: true,
      },
    },
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /routes to codex/i);
  assert.equal(codexInputs.length, 0);
});

test("runs file-disjoint Codex Steps concurrently with exact child identity", async () => {
  // Given
  const releases = new Map();
  const started = [];
  const { server } = createHarness({
    runCodexStep: async ({ workingDirectory }) => {
      started.push(workingDirectory);
      await new Promise((resolve) => releases.set(workingDirectory, resolve));
      return { finalResponse: "done" };
    },
  });
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  // When
  const second = await server.callTool("forward", {
    runId: first.runId,
    intent: "edit the second target",
    stepId: "step-c2",
  });
  await Promise.resolve();

  // Then
  assert.deepEqual(started, [
    "/tmp/worktree-step-c-1",
    "/tmp/worktree-step-c2-1",
  ]);
  assert.notEqual(first.worktreePath, second.worktreePath);
  await assert.rejects(
    server.callTool("await", {
      runId: first.runId,
      stepId: "missing-step",
      rung: first.rung,
    }),
    /No Codex attempt/,
  );
  releases.get(first.worktreePath)();
  releases.get(second.worktreePath)();
  await Promise.all([
    awaitForwarded(server, first),
    awaitForwarded(server, second),
  ]);
});

test("MCP scheduler refuses an active file-overlap while allowing disjoint work", async () => {
  // Given
  const { server } = createHarness();
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });
  const second = await server.callTool("forward", {
    runId: first.runId,
    intent: "edit the second target",
    stepId: "step-c2",
  });

  // When
  await assert.rejects(
    server.callTool("forward", {
      runId: first.runId,
      intent: "edit the target differently",
      stepId: "step-overlap",
    }),
    /overlaps active Step step-c on target\.txt/,
  );

  // Then
  assert.equal(second.status, "running");
});

test("MCP scheduler waits for durable dependency completion", async () => {
  // Given
  const { server } = createHarness();
  const first = await server.callTool("forward", {
    repoPath: "/tmp/target",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });

  // When / Then
  await assert.rejects(
    server.callTool("forward", {
      runId: first.runId,
      intent: "edit after the target",
      stepId: "step-dependent",
    }),
    /dependencies.*step-c/i,
  );
  await awaitForwarded(server, first);
  await server.callTool("check", {
    runId: first.runId,
    stepId: first.stepId,
    rung: first.rung,
  });
  const dependent = await server.callTool("forward", {
    runId: first.runId,
    intent: "edit after the target",
    stepId: "step-dependent",
  });
  assert.equal(dependent.status, "running");
});

test("refuses an approved Plan with prose criteria", async () => {
  // Given
  const { server, codexInputs } = createHarness();
  const prosePlan = `# Fleet Plan
Intent: test forwarding
## Step step-c
Intent: edit the target
Dependencies: none
Files: target.txt
Criteria: looks correct

## Step step-a
Intent: edit the companion file
Dependencies: step-c
Files: review.txt
Check Kind: review
Review: diff matches the intent
`;

  // When
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "forward",
      arguments: {
        repoPath: "/tmp/target",
        provider: "codex",
        intent: "edit the target",
        stepId: "step-c",
        plan: prosePlan,
        approved: true,
      },
    },
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Criteria/);
  assert.equal(codexInputs.length, 0);
});

test("check fails when its required Event cannot be persisted", async () => {
  // Given
  const { server } = createHarness({
    appendEvent: async () => {
      throw new Error("event store unavailable");
    },
  });
  const forwarded = await server.callTool("forward", {
    repoPath: "/tmp/target",
    provider: "codex",
    intent: "edit the target",
    stepId: "step-c",
    plan: APPROVED_PLAN,
    approved: true,
  });

  // When
  await awaitForwarded(server, forwarded);
  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "check",
      arguments: {
        runId: forwarded.runId,
        stepId: "step-c",
        rung: 1,
      },
    },
  });
  const status = await server.callTool("status", {
    runId: forwarded.runId,
  });

  // Then
  assert.equal(response.result.isError, true);
  assert.equal(status.status, "running");
});
