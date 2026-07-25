const TERMINAL = new Set(["pass", "unverified", "halt"]);
const RELEASABLE = new Set(["pass", "unverified"]);

export class SchedulerError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchedulerError";
  }
}

function assertRung(rung) {
  if (!Number.isInteger(rung) || rung < 1 || rung > 3) {
    throw new SchedulerError("Scheduler rung must be an integer from 1 to 3.");
  }
}

export function createScheduler(plan, events = []) {
  const steps = new Map(
    plan.steps.map((step) => [
      step.id,
      { step, state: "pending", rung: 0 },
    ]),
  );

  for (const event of events.filter(
    (candidate) => candidate.eventKind !== "finalization",
  )) {
    const record = steps.get(event.stepId);
    if (record === undefined || !Number.isInteger(event.rung)) {
      continue;
    }
    if (TERMINAL.has(record.state)) {
      if (
        event.outcome === "halt" &&
        event.guardrail !== undefined &&
        event.rung === record.rung
      ) {
        record.state = "halt";
        continue;
      }
      throw new SchedulerError(
        `Step ${event.stepId} has a stale Event after terminal ${record.state}.`,
      );
    }
    const expectedRung = record.state === "pending" ? 1 : record.rung + 1;
    if (event.rung !== expectedRung) {
      throw new SchedulerError(
        `Step ${event.stepId} Event rung ${event.rung} is not monotonic; expected ${expectedRung}.`,
      );
    }
    if (event.outcome === "fail") {
      if (event.rung === 3) {
        throw new SchedulerError(`Step ${event.stepId} cannot fail beyond rung 3.`);
      }
      record.state = "ready";
      record.rung = event.rung;
    } else if (event.outcome === "pass" || event.outcome === "unverified") {
      record.state = event.outcome;
      record.rung = event.rung;
    } else if (
      event.outcome === "halt" &&
      (event.rung === 3 || event.guardrail !== undefined)
    ) {
      record.state = "halt";
      record.rung = event.rung;
    } else {
      throw new SchedulerError(
        `Step ${event.stepId} Event has invalid outcome ${event.outcome}.`,
      );
    }
  }

  function requireStep(stepId) {
    const record = steps.get(stepId);
    if (record === undefined) {
      throw new SchedulerError(`Unknown Step ${stepId}.`);
    }
    return record;
  }

  function start(stepId, rung) {
    assertRung(rung);
    const record = requireStep(stepId);
    if (TERMINAL.has(record.state)) {
      throw new SchedulerError(
        `Step ${stepId} is terminal (${record.state}) and cannot start.`,
      );
    }
    if (record.state === "active") {
      throw new SchedulerError(`Step ${stepId} is already active.`);
    }
    if (
      (record.state === "pending" && rung !== 1) ||
      (record.state === "ready" && rung !== record.rung + 1)
    ) {
      throw new SchedulerError(
        `Step ${stepId} cannot start rung ${rung} from ${record.state}.`,
      );
    }
    const blocked = record.step.dependencies.filter(
      (dependency) => !RELEASABLE.has(requireStep(dependency).state),
    );
    if (blocked.length > 0) {
      throw new SchedulerError(
        `Step ${stepId} dependencies are not terminal pass or unverified: ${blocked.join(", ")}.`,
      );
    }
    const owned = new Set(record.step.files);
    for (const [otherId, other] of steps) {
      if (
        otherId === stepId ||
        (other.state !== "active" && other.state !== "ready")
      ) {
        continue;
      }
      const overlap = other.step.files.find((file) => owned.has(file));
      if (overlap !== undefined) {
        throw new SchedulerError(
          `Step ${stepId} overlaps active Step ${otherId} on ${overlap}.`,
        );
      }
    }
    record.state = "active";
    record.rung = rung;
    return { state: record.state, rung };
  }

  function complete(stepId, rung, outcome, { retry = false } = {}) {
    assertRung(rung);
    const record = requireStep(stepId);
    if (TERMINAL.has(record.state)) {
      throw new SchedulerError(
        `Step ${stepId} is terminal (${record.state}) and cannot be checked.`,
      );
    }
    if (record.state !== "active" || record.rung !== rung) {
      throw new SchedulerError(
        `Step ${stepId} has no active rung ${rung} to check.`,
      );
    }
    if (outcome === "fail" && retry) {
      record.state = "ready";
    } else if (outcome === "fail" || outcome === "halt") {
      record.state = "halt";
    } else if (outcome === "pass" || outcome === "unverified") {
      record.state = outcome;
    } else {
      throw new SchedulerError(`Invalid scheduler outcome: ${outcome}.`);
    }
    return { state: record.state, rung };
  }

  function cancelStart(stepId, rung) {
    assertRung(rung);
    const record = requireStep(stepId);
    if (record.state !== "active" || record.rung !== rung) {
      throw new SchedulerError(
        `Step ${stepId} has no active rung ${rung} to cancel.`,
      );
    }
    record.state = rung === 1 ? "pending" : "ready";
  }

  function snapshot() {
    return {
      steps: Object.fromEntries(
        [...steps].map(([stepId, record]) => [
          stepId,
          { state: record.state, rung: record.rung },
        ]),
      ),
    };
  }

  return Object.freeze({ cancelStart, complete, snapshot, start });
}
