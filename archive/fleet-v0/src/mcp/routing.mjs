export function routeWithQuota(decideRoute, dependencies, step) {
  const snapshot = dependencies.getQuota?.();
  const pool = dependencies.codexPool.snapshot();
  const decision = decideRoute(
    step,
    {
      codexAvailable: snapshot?.codexAvailable ?? true,
      claudeAvailable: snapshot?.claudeAvailable ?? true,
    },
    {
      codexActive: pool.active,
      codexCapacity: pool.capacity,
    },
  );
  return snapshot === undefined
    ? decision
    : {
        ...decision,
        quotaCapturedAt: snapshot.capturedAt ?? null,
        resetCredits: snapshot.resetCredits ?? null,
        ...(snapshot.error === undefined ? {} : { quotaError: snapshot.error }),
      };
}

export function ladderRouteWithQuota(applyQuota, dependencies, route) {
  const snapshot = dependencies.getQuota?.();
  return applyQuota(route, {
    codexAvailable: snapshot?.codexAvailable ?? true,
    claudeAvailable: snapshot?.claudeAvailable ?? true,
  });
}
