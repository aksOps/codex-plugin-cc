function isEvaluated(event) {
  return event.eventKind !== "finalization";
}

function receiptFor(event, action) {
  return {
    eventKind: "finalization",
    runId: event.runId,
    stepId: event.stepId,
    rung: event.rung,
    outcome: event.outcome,
    action,
    attemptWorktreePath: event.attemptWorktreePath ?? null,
    finalizedAt: new Date().toISOString(),
  };
}

export async function finalizeEvaluatedEvent({
  run,
  step,
  child,
  event,
  dependencies,
}) {
  let action = "already-missing";
  let result = null;
  let retainedChild = null;
  if (event.outcome === "fail" && event.rung === 1) {
    return { action: "retained", child, receipt: null, result: null };
  }
  if (child !== null) {
    if (event.outcome === "pass" || event.outcome === "unverified") {
      action = "merged";
      result = await dependencies.mergeStepWorktree({
        child,
        run,
        files: step.files,
      });
    } else {
      action = "discarded";
      result = await dependencies.discardStepWorktree(child);
    }
  } else {
    await dependencies.cleanupStepWorktreeLeftover({
      run,
      stepId: step.id,
      worktreePath: event.attemptWorktreePath,
    });
  }
  const receipt = receiptFor(event, action);
  await dependencies.appendEvent(run.eventsPath, receipt);
  return { action, child: retainedChild, receipt, result };
}

export async function reconcileFinalizations({
  run,
  plan,
  events,
  dependencies,
}) {
  const recoveredChildren = new Map();
  const unknownInFlight = [];
  for (const step of plan.steps) {
    const stepEvents = events.filter((event) => event.stepId === step.id);
    const evaluated = stepEvents.filter(isEvaluated);
    const last = evaluated.at(-1);
    let child = null;
    if (last?.attemptWorktreePath !== undefined) {
      child = await dependencies.recoverStepWorktree({
        run,
        stepId: step.id,
        worktreePath: last.attemptWorktreePath,
      });
    }
    child ??= await dependencies.findStepWorktree({ run, stepId: step.id });
    if (last === undefined) {
      if (child !== null) {
        recoveredChildren.set(step.id, child);
        unknownInFlight.push(step.id);
      }
      continue;
    }
    if (last.outcome === "fail" && last.rung === 1) {
      if (child !== null) {
        recoveredChildren.set(step.id, child);
      }
      continue;
    }
    const receipt = stepEvents.findLast(
      (event) =>
        event.eventKind === "finalization" &&
        event.rung === last.rung &&
        event.outcome === last.outcome,
    );
    if (receipt !== undefined && child === null) {
      await dependencies.cleanupStepWorktreeLeftover({
        run,
        stepId: step.id,
        worktreePath: last.attemptWorktreePath,
      });
      continue;
    }
    const finalized = await finalizeEvaluatedEvent({
      run,
      step,
      child,
      event: last,
      dependencies,
    });
    if (finalized.receipt !== null) {
      events.push(finalized.receipt);
    }
  }
  return { recoveredChildren, unknownInFlight };
}

export function evaluatedEvents(events) {
  return events.filter(isEvaluated);
}
