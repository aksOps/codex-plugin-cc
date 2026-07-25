const OUTCOMES = new Set(["pass", "fail", "halt", "unverified"]);
const CHECK_KINDS = new Set(["command", "review"]);

function passRate(records) {
  const passed = records.filter(({ outcome }) => outcome === "pass").length;
  return { total: records.length, passed, passRate: passed / records.length };
}

function groups(records, keyFor, includeMedian = false) {
  const grouped = Map.groupBy(records, keyFor);
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => {
      const result = { key, ...passRate(entries) };
      if (includeMedian) {
        const values = entries.map(({ durationMs }) => durationMs).sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        result.medianDurationMs =
          values.length % 2 === 0
            ? (values[middle - 1] + values[middle]) / 2
            : values[middle];
      }
      return result;
    });
}

export function calculateStats(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("Fleet stats requires an Event array.");
  }
  const routes = events.filter(
    (event) =>
      event?.eventKind !== "finalization" &&
      typeof event?.rule === "string" &&
      OUTCOMES.has(event.outcome) &&
      typeof event.degraded === "boolean" &&
      CHECK_KINDS.has(event.checkKind) &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0,
  );
  return {
    byRule: groups(routes, ({ rule }) => rule, true),
    byDegraded: groups(routes, ({ degraded }) => String(degraded)),
    byCheckKind: groups(routes, ({ checkKind }) => checkKind),
  };
}
