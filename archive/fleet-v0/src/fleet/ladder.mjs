export const MAX_LADDER_RUNG = 3;

export class LadderError extends Error {
  constructor(message) {
    super(message);
    this.name = "LadderError";
  }
}

export function assertLadderRung(rung) {
  if (!Number.isInteger(rung) || rung < 1 || rung > MAX_LADDER_RUNG) {
    throw new LadderError(`Ladder rung must be an integer from 1 to 3.`);
  }
  return rung;
}

function routeIdentity(route, provider, tier, effort) {
  return { ...route, provider, tier, effort };
}

export function harderRoute(route) {
  if (route.provider === "claude") {
    return routeIdentity(
      route,
      "claude",
      "fleet:deep",
      route.tier === "fleet:deep" && route.effort === "high"
        ? "xhigh"
        : route.effort === "xhigh"
          ? "xhigh"
          : "high",
    );
  }
  return routeIdentity(
    route,
    "codex",
    "fleet:codex-high",
    route.tier === "fleet:codex-high" && route.effort === "high"
      ? "xhigh"
      : route.effort === "xhigh"
        ? "xhigh"
        : "high",
  );
}

export function crossProviderRoute(route) {
  return route.provider === "codex"
    ? routeIdentity(route, "claude", "fleet:deep", "high")
    : routeIdentity(route, "codex", "fleet:codex-high", "high");
}

export function nextLadderRoute(route, failedRung) {
  assertLadderRung(failedRung);
  if (failedRung === 1) {
    return harderRoute(route);
  }
  if (failedRung === 2) {
    return crossProviderRoute(route);
  }
  return null;
}

export function publicRoute(route) {
  return {
    provider: route.provider,
    tier: route.tier,
    effort: route.effort,
  };
}

function recordedRoute(event) {
  if (
    (event.provider !== "codex" && event.provider !== "claude") ||
    typeof event.tier !== "string" ||
    typeof event.effort !== "string"
  ) {
    throw new LadderError("Recorded Fleet Event has an invalid Route.");
  }
  return {
    provider: event.provider,
    tier: event.tier,
    effort: event.effort,
    shape: event.shape,
    rule: event.rule,
    degraded: event.degraded,
    intendedTier: event.intendedTier,
    tiers: [],
  };
}

export function recoverLadderAttempt(events, step) {
  const relevant = events.filter(
    (event) =>
      event.stepId === step.id && event.eventKind !== "finalization",
  );
  if (relevant.length === 0) {
    return null;
  }
  const last = relevant.at(-1);
  const rung = assertLadderRung(last.rung);
  if (
    last.outcome === "pass" ||
    last.outcome === "unverified" ||
    last.outcome === "halt"
  ) {
    return {
      phase: "terminal",
      rung,
      nextRoute: null,
      previousFailure: null,
      step,
    };
  }
  if (last.outcome !== "fail" || rung === MAX_LADDER_RUNG) {
    throw new LadderError("Recorded Fleet Event has an invalid ladder outcome.");
  }
  const route = recordedRoute(last);
  return {
    phase: "ready",
    rung,
    nextRoute: nextLadderRoute(route, rung),
    previousFailure: rung === 1 ? (last.failureEvidence ?? null) : null,
    step,
  };
}
