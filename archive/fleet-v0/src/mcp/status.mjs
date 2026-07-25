export function createStatusTool({
  attempts,
  children,
  dependencies,
  prepareStatus,
  runtimeFor,
  stepKey,
  stringField,
}) {
  return async function status(input) {
    const runId = stringField(input, "runId", "status");
    const { run, plan } = await prepareStatus(runId);
    const runtime = await runtimeFor(run, plan);
    const activeAttempts = [...attempts.values()]
      .filter((attempt) => attempt.runId === runId)
      .map((attempt) => ({
        stepId: attempt.step.id,
        rung: attempt.rung,
        state: attempt.phase,
        provider: attempt.route?.provider ?? attempt.nextRoute?.provider,
        worktreePath: attempt.child?.worktreePath ?? null,
      }));
    for (const stepId of runtime.unknownInFlight) {
      if (!activeAttempts.some((attempt) => attempt.stepId === stepId)) {
        activeAttempts.push({
          stepId,
          rung: null,
          state: "unknown-in-flight",
          provider: null,
          worktreePath: children.get(stepKey(runId, stepId))?.worktreePath ?? null,
        });
      }
    }
    return {
      runId,
      status: activeAttempts.some(({ state }) => state !== "terminal")
        ? "running"
        : run.state,
      worktreePath: run.worktreePath,
      planPath: run.planPath,
      diff: await dependencies.getRunDiff(runId),
      attempts: activeAttempts,
      scheduler: runtime?.scheduler.snapshot() ?? null,
      pool: dependencies.codexPool.snapshot(),
    };
  };
}
