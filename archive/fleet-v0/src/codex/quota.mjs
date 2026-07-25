import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { openCodexAppServer } from "./auth.mjs";

export class CodexQuotaError extends Error {
  name = "CodexQuotaError";
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexQuotaError(`${label} must be an object.`);
  }
  return value;
}

function parseWindow(value, label) {
  const input = record(value, label);
  if (
    !Number.isFinite(input.usedPercent) ||
    !Number.isFinite(input.windowDurationMins) ||
    !Number.isFinite(input.resetsAt)
  ) {
    throw new CodexQuotaError(
      `${label} requires camelCase usedPercent, windowDurationMins, and resetsAt fields.`,
    );
  }
  return {
    usedPercent: input.usedPercent,
    windowDurationMins: input.windowDurationMins,
    resetsAt: input.resetsAt,
  };
}

function parseRateLimits(value) {
  const input = record(value, "Codex rateLimits");
  if (!Object.hasOwn(input, "rateLimitReachedType")) {
    throw new CodexQuotaError(
      "Codex rateLimits requires camelCase rateLimitReachedType.",
    );
  }
  if (
    input.rateLimitReachedType !== null &&
    typeof input.rateLimitReachedType !== "string"
  ) {
    throw new CodexQuotaError(
      "Codex rateLimitReachedType must be null or a string.",
    );
  }
  return {
    primary:
      input.primary === null || input.primary === undefined
        ? null
        : parseWindow(input.primary, "Codex primary rate limit"),
    secondary:
      input.secondary === null || input.secondary === undefined
        ? null
        : parseWindow(input.secondary, "Codex secondary rate limit"),
    rateLimitReachedType: input.rateLimitReachedType,
  };
}

function parseResetCredits(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const input = record(value, "Codex rateLimitResetCredits");
  if (!Number.isInteger(input.availableCount) || input.availableCount < 0) {
    throw new CodexQuotaError(
      "Codex rateLimitResetCredits requires camelCase availableCount.",
    );
  }
  return { availableCount: input.availableCount };
}

function buildSnapshot(
  { rateLimits, rateLimitResetCredits },
  capturedAt,
  codexFloor,
) {
  const parsedRateLimits = parseRateLimits(rateLimits);
  const usedPercent = Math.max(
    parsedRateLimits.primary?.usedPercent ?? 0,
    parsedRateLimits.secondary?.usedPercent ?? 0,
  );
  return {
    capturedAt,
    codexAvailable:
      parsedRateLimits.rateLimitReachedType === null &&
      usedPercent <= codexFloor,
    codexFloor,
    rateLimits: parsedRateLimits,
    resetCredits: parseResetCredits(rateLimitResetCredits),
  };
}

export async function startCodexQuotaMonitor({
  repoRoot,
  codexFloor = 85,
  quotaPath = path.join(repoRoot, ".fleet", "quota.json"),
  now = () => new Date().toISOString(),
  ...options
}) {
  if (!Number.isFinite(codexFloor) || codexFloor < 0 || codexFloor > 100) {
    throw new TypeError("Codex quota floor must be between 0 and 100.");
  }
  const session = await openCodexAppServer({ repoRoot, ...options });
  let snapshot;
  let queued = Promise.resolve();
  let pendingUpdate;
  let updateCount = 0;
  const updateWaiters = new Set();

  async function persist(nextRateLimits, nextCredits) {
    const nextSnapshot = buildSnapshot(
      {
        rateLimits: nextRateLimits,
        rateLimitResetCredits: nextCredits,
      },
      now(),
      codexFloor,
    );
    await mkdir(path.dirname(quotaPath), { recursive: true });
    await writeFile(quotaPath, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
    snapshot = nextSnapshot;
  }

  async function applyUpdate(updated) {
    if (snapshot === undefined) {
      pendingUpdate = updated;
      return;
    }
    await persist(
      updated.rateLimits,
      updated.rateLimitResetCredits ?? snapshot.resetCredits,
    );
    updateCount += 1;
    for (const resolve of updateWaiters) {
      resolve(snapshot);
    }
    updateWaiters.clear();
  }

  session.onNotification("account/rateLimits/updated", (updated) => {
    queued = queued.then(() => applyUpdate(updated));
  });

  try {
    const seeded = await session.request("account/rateLimits/read", {});
    await persist(seeded.rateLimits, seeded.rateLimitResetCredits);
    if (pendingUpdate !== undefined) {
      const update = pendingUpdate;
      pendingUpdate = undefined;
      queued = queued.then(() => applyUpdate(update));
    }
  } catch (error) {
    await session.close();
    throw new CodexQuotaError("Unable to read Codex rate limits", {
      cause: error,
    });
  }

  return {
    close: () => session.close(),
    flush: () => queued,
    getSnapshot: () => snapshot,
    waitForUpdate: () => {
      if (updateCount > 0) {
        return Promise.resolve(snapshot);
      }
      return new Promise((resolve) => updateWaiters.add(resolve));
    },
  };
}
