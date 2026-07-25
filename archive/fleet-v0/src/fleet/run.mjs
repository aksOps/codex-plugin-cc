import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { appendEvent } from "./events.mjs";
import { digestPlan } from "./plan.mjs";
import { createRunWorktree, getWorktreeDiff, reapRunWorktree } from "./worktree.mjs";

const runRecords = new Map();

export class FleetRunError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "FleetRunError";
  }
}

function publicStatus(record) {
  return {
    runId: record.runId, state: record.state, intent: record.intent,
    repoRoot: record.repoRoot, worktreePath: record.worktreePath,
    metadataPath: record.metadataPath, eventsPath: record.eventsPath,
    planPath: record.planPath,
    planDigest: record.planDigest,
    diff: record.diff, error: record.error,
  };
}

function requireRecord(runId) {
  const record = runRecords.get(runId);
  if (record === undefined) {
    throw new FleetRunError(`Unknown Fleet Run: ${runId}`);
  }
  return record;
}

function routeEvent(record, provider, tier, startedAt, fields) {
  return {
    runId: record.runId, stepId: `${provider}-1`,
    shape: { stage: 1 }, rule: null, tier, provider,
    rung: 1, degraded: false, intendedTier: null,
    criteria: null, checkKind: "review",
    durationMs: Date.now() - startedAt,
    humanOverride: null, ...fields,
  };
}

async function recordRoute(record, provider, worker, codexHome) {
  const stepId = `${provider}-1`;
  const tier = provider === "codex" ? "fleet:codex-high" : "fleet:deep";
  const startedAt = Date.now();
  const context = {
    intent: record.intent,
    stepId,
    runId: record.runId,
    worktreePath: record.worktreePath,
    metadataPath: record.metadataPath,
    eventsPath: record.eventsPath,
    ...(codexHome === undefined ? {} : { codexHome }),
  };

  try {
    const result = await worker(context);
    const usage =
      result !== null && typeof result === "object" && "usage" in result
        ? (result.usage ?? null)
        : null;
    await appendEvent(
      record.eventsPath,
      routeEvent(record, provider, tier, startedAt, {
        outcome: "unverified",
        usage,
      }),
    );
    return result;
  } catch (error) {
    await appendEvent(
      record.eventsPath,
      routeEvent(record, provider, tier, startedAt, {
        outcome: "fail",
        usage: null,
      }),
    );
    throw error;
  }
}

export async function createRun(
  {
    repoRoot,
    intent,
    planMarkdown,
    runId = randomUUID(),
    worktreeRoot,
  },
) {
  if (typeof intent !== "string" || intent.trim() === "") {
    throw new FleetRunError("Fleet Run intent must be a non-empty string");
  }
  if (runRecords.has(runId)) {
    throw new FleetRunError(`Fleet Run already exists: ${runId}`);
  }

  const worktree = await createRunWorktree({
    repoPath: repoRoot,
    runId,
    worktreeRoot,
  });
  const metadataPath = join(worktree.worktreePath, ".fleet", `run-${runId}`);
  const eventsPath = join(metadataPath, "events.jsonl");
  const persistedPlan =
    planMarkdown === undefined
      ? undefined
      : planMarkdown.endsWith("\n")
        ? planMarkdown
        : `${planMarkdown}\n`;
  const planDigest =
    persistedPlan === undefined ? null : digestPlan(persistedPlan);
  try {
    await mkdir(metadataPath, { recursive: true });
    await writeFile(
      join(metadataPath, "run.json"),
      `${JSON.stringify({ runId, intent, state: "created", planDigest }, null, 2)}\n`,
      "utf8",
    );
    if (persistedPlan !== undefined) {
      await writeFile(
        join(metadataPath, "plan.md"),
        persistedPlan,
        "utf8",
      );
    }
  } catch (error) {
    await reapRunWorktree(worktree);
    throw new FleetRunError(`Failed to initialize Fleet Run: ${runId}`, {
      cause: error,
    });
  }

  const record = {
    ...worktree,
    repoRoot: worktree.repoPath,
    intent,
    metadataPath,
    eventsPath,
    planPath:
      planMarkdown === undefined ? null : join(metadataPath, "plan.md"),
    planDigest,
    state: "created",
    diff: null,
    error: null,
    completion: null,
  };
  runRecords.set(runId, record);
  return publicStatus(record);
}

export async function executeRun(
  { runId, codexWorker, claudeWorker, codexHome },
) {
  const record = requireRecord(runId);
  if (record.state !== "created") {
    throw new FleetRunError(
      `Fleet Run ${runId} cannot execute from state ${record.state}`,
    );
  }
  if (typeof codexWorker !== "function" || typeof claudeWorker !== "function") {
    throw new FleetRunError("Fleet Run requires Codex and Claude workers");
  }

  record.state = "running";
  try {
    const codexResult = await recordRoute(
      record,
      "codex",
      codexWorker,
      codexHome,
    );
    const claudeResult = await recordRoute(
      record,
      "claude",
      claudeWorker,
      codexHome,
    );
    record.diff = await getWorktreeDiff(record.worktreePath);
    record.state = "completed";
    await writeFile(
      join(record.metadataPath, "diff.patch"),
      record.diff,
      "utf8",
    );
    return {
      ...publicStatus(record),
      codexResult,
      claudeResult,
    };
  } catch (error) {
    record.state = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    await reapRunWorktree(record);
    throw error;
  }
}

export async function startRun(options) {
  const status = await createRun(options);
  const completion = executeRun({
    runId: status.runId,
    codexWorker: options.codexWorker,
    claudeWorker: options.claudeWorker,
    codexHome: options.codexHome,
  });
  requireRecord(status.runId).completion = completion;
  completion.catch(() => undefined);
  return getRunStatus(status.runId);
}

export function getRunStatus(runId) {
  const record = runRecords.get(runId);
  return record === undefined ? null : publicStatus(record);
}

export async function getRunDiff(runId) {
  const record = requireRecord(runId);
  record.diff = await getWorktreeDiff(record.worktreePath);
  await writeFile(join(record.metadataPath, "diff.patch"), record.diff, "utf8");
  return record.diff;
}

export async function awaitRun(runId) {
  const record = requireRecord(runId);
  if (record.completion !== null) {
    return record.completion;
  }
  if (record.state === "completed") {
    return publicStatus(record);
  }
  throw new FleetRunError(`Fleet Run ${runId} was not started asynchronously`);
}

export async function cleanupRun(runId) {
  const record = requireRecord(runId);
  if (record.state === "running") {
    throw new FleetRunError(`Fleet Run ${runId} is still running`);
  }
  await reapRunWorktree(record);
  runRecords.delete(runId);
}

export function createFleetRunner({ codexWorker, claudeWorker, codexHome }) {
  return async (input) =>
    runFleet({ ...input, codexWorker, claudeWorker, codexHome });
}

export async function runFleet(options) {
  const status = await createRun(options);
  return executeRun({
    runId: status.runId,
    codexWorker: options.codexWorker,
    claudeWorker: options.claudeWorker,
    codexHome: options.codexHome,
  });
}

export async function cleanupFleetRun(run) {
  const record = runRecords.get(run.runId);
  if (record === undefined) {
    await reapRunWorktree(run);
    return;
  }
  await cleanupRun(run.runId);
}
