import { evaluateCriterion } from "../fleet/criteria.mjs";
import {
  assertLadderRung,
  nextLadderRoute,
  publicRoute,
} from "../fleet/ladder.mjs";
import {
  eventFor,
  resetFailure,
  workerFailure,
} from "./check-event.mjs";

export function createCheckTool({
  attempts,
  attemptKey,
  children,
  dependencies,
  InputError,
  jobs,
  schedulers,
  stepKey,
  requireRun,
  stringField,
}) {
  return async function check(input) {
    const runId = stringField(input, "runId", "check");
    const stepId = stringField(input, "stepId", "check");
    const rung = assertLadderRung(input.rung);
    const run = await requireRun(runId);
    const key = stepKey(runId, stepId);
    const attempt = attempts.get(key);
    if (attempt === undefined) {
      throw new InputError(`No attempt exists for Step ${stepId}; call forward first.`);
    }
    if (attempt.phase === "terminal") {
      throw new InputError(`Step ${stepId} is terminal and cannot be checked.`);
    }
    if (attempt.phase !== "forwarded") {
      throw new InputError(`Step ${stepId} must be forwarded before it can be checked.`);
    }
    if (attempt.rung !== rung) {
      throw new InputError(
        `Step ${stepId} is on rung ${attempt.rung}, not requested rung ${rung}.`,
      );
    }
    const job = jobs.get(attemptKey(runId, stepId, rung));
    if (
      attempt.route.provider === "codex" &&
      (job?.stepId !== stepId || job.rung !== rung)
    ) {
      throw new InputError(`Codex attempt state is unavailable for Step ${stepId}.`);
    }
    if (
      attempt.route.provider === "codex" &&
      (job.status === "queued" || job.status === "running")
    ) {
      throw new InputError(`Codex Step ${stepId} is still running; call await first.`);
    }
    const workerError =
      attempt.route.provider === "codex"
        ? (job.error ?? null)
        : (stringField(input, "workerError", "check", true) ?? null);
    const suppliedEvidence =
      stringField(input, "failureEvidence", "check", true) ?? null;
    if (attempt.route.provider === "claude") {
      attempt.completedAt = Date.now();
      attempt.completedAtIso = new Date(attempt.completedAt).toISOString();
    }
    const evaluated = await dependencies.evaluateCriterion({
      step: attempt.step,
      worktreePath: attempt.child.worktreePath,
      workerError,
      failureEvidence: suppliedEvidence,
    });
    const criteriaOutcome =
      attempt.step.checkKind === "review"
        ? "unverified"
        : workerError !== null
          ? "fail"
          : evaluated.outcome;
    const evidence = workerFailure(evaluated.failureEvidence, workerError);
    const candidateRoute =
      criteriaOutcome === "fail"
        ? nextLadderRoute(attempt.route, rung)
        : null;
    const nextRoute =
      candidateRoute === null
        ? null
        : dependencies.applyLadderQuota(candidateRoute);
    const outcome =
      criteriaOutcome === "fail" && nextRoute === null
        ? "halt"
        : criteriaOutcome;
    const event = eventFor({
      run,
      attempt,
      rung,
      criteriaOutcome,
      outcome,
      failureEvidence: evidence,
      expected: evaluated.expected ?? null,
    });
    await dependencies.appendEvent(run.eventsPath, event);
    let reset = null;
    let merge = null;
    const scheduler = schedulers.get(runId)?.scheduler;
    if (scheduler === undefined) {
      throw new Error(`Scheduler state is unavailable for Run ${runId}.`);
    }
    try {
      const finalized = await dependencies.finalizeEvaluatedEvent({
        run,
        step: attempt.step,
        child: attempt.child,
        event,
        dependencies,
      });
      attempt.child = finalized.child;
      if (finalized.child === null) {
        children.delete(key);
      }
      if (finalized.action === "merged") {
        merge = finalized.result;
      } else if (
        finalized.action === "discarded" &&
        criteriaOutcome === "fail" &&
        rung === 2
      ) {
        reset = finalized.result;
      }
    } catch (error) {
      attempt.phase = "terminal";
      attempt.nextRoute = null;
      jobs.delete(attemptKey(runId, stepId, rung));
      const cleanupError = dependencies.errorMessage(error);
      const guardEvent = {
        ...event,
        completedAt: new Date().toISOString(),
        outcome: "halt",
        guardrail: "child-worktree",
        failureEvidence: resetFailure(evidence, cleanupError),
      };
      try {
        await dependencies.appendEvent(run.eventsPath, guardEvent);
        const finalized = await dependencies.finalizeEvaluatedEvent({
          run,
          step: attempt.step,
          child: attempt.child,
          event: guardEvent,
          dependencies,
        });
        attempt.child = finalized.child;
        children.delete(key);
        scheduler.complete(stepId, rung, "halt");
      } catch (appendError) {
        throw new Error(
          `Child worktree finalization failed: ${cleanupError}; terminal Event failed: ${dependencies.errorMessage(appendError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    scheduler.complete(stepId, rung, outcome, {
      retry: criteriaOutcome === "fail" && nextRoute !== null,
    });
    attempt.phase =
      criteriaOutcome === "fail" && nextRoute !== null ? "ready" : "terminal";
    attempt.nextRoute = nextRoute;
    attempt.previousFailure = rung === 1 ? evidence : null;
    if (attempt.route.provider === "codex") {
      jobs.delete(attemptKey(runId, stepId, rung));
    }
    return {
      runId,
      stepId,
      rung,
      outcome: criteriaOutcome,
      status: outcome === "halt" ? "halted" : attempt.phase,
      nextRoute: nextRoute === null ? null : publicRoute(nextRoute),
      ...(reset === null ? {} : { reset }),
      ...(merge === null ? {} : { merge }),
      failureEvidence: evidence,
      scheduler: scheduler.snapshot(),
      pool: dependencies.codexPool.snapshot(),
    };
  };
}

export const checkDefaults = Object.freeze({
  evaluateCriterion,
});
