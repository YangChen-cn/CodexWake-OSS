// Extract a candidate scheduling snapshot from an authenticated App Server
// response. This does not prove that a request started a new window.
export function extractFiveHourSnapshot(result, { limitId, observedAtMs }) {
  if (!result || typeof result !== "object" || typeof limitId !== "string" || !limitId ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) throw new Error("Invalid quota observation");
  const byId = result.rateLimitsByLimitId;
  let bucket;
  if (byId && typeof byId === "object" && !Array.isArray(byId) && Object.hasOwn(byId, limitId)) {
    bucket = byId[limitId];
  } else if (result.rateLimits?.limitId === limitId) {
    bucket = result.rateLimits;
  }
  if (!bucket || typeof bucket !== "object" || (bucket.limitId != null && bucket.limitId !== limitId)) {
    throw new Error("Requested quota bucket is unavailable");
  }
  const windows = [bucket.primary, bucket.secondary].filter((window) => window?.windowDurationMins === 300);
  if (windows.length !== 1) throw new Error("Five-hour quota window is missing or ambiguous");
  const window = windows[0];
  if (!Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0 ||
      !Number.isSafeInteger(window.resetsAt * 1000) || window.resetsAt * 1000 < observedAtMs ||
      typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 || window.usedPercent > 100) throw new Error("Quota window data is incomplete or stale");
  return { source: "account/rateLimits/read", limitId, windowDurationMins: 300,
    observedAtMs, resetAtMs: window.resetsAt * 1000, usedPercent: window.usedPercent };
}
