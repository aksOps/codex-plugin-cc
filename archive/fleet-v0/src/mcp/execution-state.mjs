export function createExecutionState(dependencies) {
  const jobs = new Map();
  const attempts = new Map();
  const schedulers = new Map();
  const children = new Map();
  const stepKey = (runId, stepId) => `${runId}\0${stepId}`;
  const attemptKey = (runId, stepId, rung) =>
    `${stepKey(runId, stepId)}\0${rung}`;

  async function runtimeFor(run, plan) {
    const existing = schedulers.get(run.runId);
    if (existing !== undefined) {
      return existing;
    }
    const events = (await dependencies.readEvents(run.eventsPath)).filter(
      (event) => event.runId === run.runId,
    );
    const reconciled = await dependencies.reconcileFinalizations({
      run,
      plan,
      events,
      dependencies,
    });
    for (const [stepId, child] of reconciled.recoveredChildren) {
      children.set(stepKey(run.runId, stepId), child);
    }
    const runtime = {
      events,
      scheduler: dependencies.createScheduler(plan, events),
      unknownInFlight: reconciled.unknownInFlight,
    };
    schedulers.set(run.runId, runtime);
    return runtime;
  }

  return Object.freeze({
    attemptKey,
    attempts,
    children,
    jobs,
    runtimeFor,
    schedulers,
    stepKey,
  });
}
