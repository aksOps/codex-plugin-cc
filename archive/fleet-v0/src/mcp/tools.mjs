import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexStep } from "../codex/worker.mjs";
import { appendEvent, readEvents } from "../fleet/events.mjs";
import { globalCodexPool } from "../fleet/pool.mjs";
import { createRun, getRunDiff, getRunStatus } from "../fleet/run.mjs";
import { createScheduler } from "../fleet/scheduler.mjs";
import {
  createStepWorktree,
  cleanupStepWorktreeLeftover,
  discardStepWorktree,
  findStepWorktree,
  mergeStepWorktree,
  recoverStepWorktree,
} from "../fleet/step-worktree.mjs";
import { getWorktreeDiff } from "../fleet/worktree.mjs";
import { digestPlan, parsePlan } from "../fleet/plan.mjs";
import {
  applyQuota,
  route as decideRoute,
} from "../router/rules.mjs";
import {
  createExecutionController,
} from "./execution.mjs";
import { checkDefaults } from "./check.mjs";
import {
  evaluatedEvents,
  finalizeEvaluatedEvent,
  reconcileFinalizations,
} from "./finalization.mjs";
import {
  errorMessage,
  parseObject,
  stringField,
  ToolInputError,
} from "./input.mjs";
import {
  ladderRouteWithQuota,
  routeWithQuota,
} from "./routing.mjs";

const FLEET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function routingEnvelope(step) {
  return `<fleet-route approved="true">
Intent: ${step.intent}
Files: ${step.files.length === 0 ? "none" : step.files.join(", ")}
Check Kind: ${step.checkKind}
</fleet-route>`;
}

function nativeAgent({ step, route, run, prompt }) {
  return {
    subagentType: route.tier,
    effort: route.effort,
    worktreePath: run.worktreePath,
    prompt:
      `${routingEnvelope(step)}\n` +
      `Work only in ${run.worktreePath}. Execute Fleet Step ${step.id} ` +
      `as ${route.tier} at ${route.effort} effort: ${prompt}`,
  };
}

export function createToolHandler(overrides = {}) {
  const dependencies = {
    fleetRoot: FLEET_ROOT,
    codexHome: process.env.FLEET_CODEX_HOME,
    createRun,
    getRunStatus,
    getRunDiff,
    appendEvent,
    readEvents,
    readPlan: readFile,
    runCodexStep,
    codexPool: globalCodexPool,
    createScheduler,
    createStepWorktree,
    cleanupStepWorktreeLeftover,
    discardStepWorktree,
    findStepWorktree,
    mergeStepWorktree,
    recoverStepWorktree,
    evaluatedEvents,
    finalizeEvaluatedEvent,
    reconcileFinalizations,
    getWorktreeDiff,
    nativeAgent,
    errorMessage,
    applyLadderQuota: (route) =>
      ladderRouteWithQuota(applyQuota, dependencies, route),
    ...checkDefaults,
    ...overrides,
  };
  const routeStep = (step) => routeWithQuota(decideRoute, dependencies, step);
  const approvedPlans = new Map();

  function requireApprovedStep(plan, stepId, intent) {
    const step = plan.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined || step.intent !== intent) {
      throw new ToolInputError(
        `Step ${stepId} must match the exact approved Plan intent.`,
      );
    }
    return step;
  }

  async function requireRun(runId) {
    const run = await dependencies.getRunStatus(runId);
    if (run === null) {
      throw new ToolInputError(
        `Unknown Run ID ${runId}. Call forward with repoPath first.`,
      );
    }
    return run;
  }

  async function approvedPlanForRun(run) {
    const cached = approvedPlans.get(run.runId);
    if (cached !== undefined) {
      return cached;
    }
    if (typeof run.planPath !== "string" || run.planPath.length === 0) {
      throw new ToolInputError(
        `Approved Plan context is unavailable for Run ${run.runId}.`,
      );
    }
    if (typeof run.planDigest !== "string" || run.planDigest.length === 0) {
      throw new ToolInputError(
        `Approved Plan digest is unavailable for Run ${run.runId}.`,
      );
    }
    try {
      const markdown = await dependencies.readPlan(run.planPath, "utf8");
      if (digestPlan(markdown) !== run.planDigest) {
        throw new Error("persisted Plan does not match its approved digest");
      }
      const plan = parsePlan(markdown);
      approvedPlans.set(run.runId, plan);
      return plan;
    } catch (error) {
      throw new ToolInputError(
        `Cannot reload the approved Plan for Run ${run.runId}: ${errorMessage(error)}`,
      );
    }
  }

  async function prepareForward({
    input,
    intent,
    stepId,
    requestedRunId,
    requestedProvider,
  }) {
    if (requestedRunId !== undefined) {
      const run = await requireRun(requestedRunId);
      const plan = await approvedPlanForRun(run);
      return { run, plan, step: requireApprovedStep(plan, stepId, intent) };
    }
    if (input.approved !== true) {
      throw new ToolInputError(
        "A new Fleet Run requires explicit Plan approval.",
      );
    }
    const planMarkdown = stringField(input, "plan", "forward");
    const plan = parsePlan(planMarkdown);
    const step = requireApprovedStep(plan, stepId, intent);
    const initialRoute = routeStep(step);
    if (
      requestedProvider !== undefined &&
      requestedProvider !== initialRoute.provider
    ) {
      throw new ToolInputError(
        `Step ${stepId} routes to ${initialRoute.provider}, not requested provider ${requestedProvider}.`,
      );
    }
    const run = await dependencies.createRun({
      repoRoot: stringField(input, "repoPath", "forward"),
      intent,
      planMarkdown,
    });
    approvedPlans.set(run.runId, plan);
    return { run, plan, step };
  }

  async function prepareStatus(runId) {
    const run = await requireRun(runId);
    return { run, plan: await approvedPlanForRun(run) };
  }

  const execution = createExecutionController({
    dependencies,
    InputError: ToolInputError,
    decideRoute: routeStep,
    prepareForward,
    prepareStatus,
    requireRun,
    stringField,
  });

  async function route(input) {
    const intent = stringField(input, "intent", "route");
    const stepId = stringField(input, "stepId", "route");
    const requestedRunId = stringField(input, "runId", "route", true);
    let plan;
    let runId;
    if (requestedRunId === undefined) {
      if (input.approved !== true) {
        throw new ToolInputError(
          "Routing a new Fleet Run requires explicit Plan approval.",
        );
      }
      plan = parsePlan(stringField(input, "plan", "route"));
    } else {
      const run = await requireRun(requestedRunId);
      plan = await approvedPlanForRun(run);
      runId = run.runId;
    }
    const step = requireApprovedStep(plan, stepId, intent);
    return {
      ...(runId === undefined ? {} : { runId }),
      stepId,
      ...routeStep(step),
    };
  }

  return async function callTool(name, rawArguments = {}) {
    const input = parseObject(rawArguments, name);
    switch (name) {
      case "forward":
        return execution.forward(input);
      case "route":
        return route(input);
      case "await":
        return execution.awaitCodex(input);
      case "status":
        return execution.status(input);
      case "check":
        return execution.check(input);
      default:
        throw new ToolInputError(
          `Unknown tool ${name}. Use route, forward, await, status, or check.`,
        );
    }
  };
}
