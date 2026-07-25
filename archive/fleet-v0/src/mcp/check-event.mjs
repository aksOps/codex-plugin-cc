function withFailure(evidence, field, value) {
  if (
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence)
  ) {
    return { ...evidence, [field]: value };
  }
  return {
    ...(evidence === null ? {} : { criterionEvidence: evidence }),
    [field]: value,
  };
}

export function workerFailure(evidence, workerError) {
  return workerError === null
    ? evidence
    : withFailure(evidence, "workerError", workerError);
}

export function resetFailure(evidence, resetError) {
  return withFailure(evidence, "resetError", resetError);
}

export function eventFor({
  run,
  attempt,
  rung,
  criteriaOutcome,
  outcome,
  failureEvidence,
  expected,
}) {
  const { route, step } = attempt;
  return {
    runId: run.runId,
    stepId: step.id,
    shape: route.shape,
    rule: route.rule,
    tier: route.tier,
    effort: route.effort,
    provider: route.provider,
    rung,
    degraded: route.degraded,
    intendedTier: route.intendedTier,
    criteria:
      step.checkKind === "command"
        ? step.criteria.command
        : step.criteria.review,
    expected,
    checkKind: step.checkKind,
    criteriaOutcome,
    outcome,
    durationMs: attempt.completedAt - attempt.startedAt,
    startedAt: attempt.startedAtIso,
    completedAt: attempt.completedAtIso,
    evaluatedAt: new Date().toISOString(),
    attemptWorktreePath: attempt.child.worktreePath,
    usage: attempt.usage,
    failureEvidence,
    humanOverride: null,
  };
}
