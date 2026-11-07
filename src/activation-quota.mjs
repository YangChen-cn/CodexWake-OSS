import { extractFiveHourSnapshot } from "./quota.mjs";

// Observed quota is an additional veto for the conservative mode, never proof
// that another client did not already start a new window. Do not use a zero
// percentage or a future reset to claim that a window has been activated.
export function assessActivationQuota(result, { limitId, observedAtMs }) {
  if (!result || result.ordinaryUsageAllowed !== true) return { allowed: false, reason: "ordinary_usage_unconfirmed" };
  const byId = result.rateLimitsByLimitId;
  const bucket = byId && typeof byId === "object" && !Array.isArray(byId) && Object.hasOwn(byId, limitId)
    ? byId[limitId] : result.rateLimits?.limitId === limitId ? result.rateLimits : null;
  if (!bucket || typeof bucket !== "object") return { allowed: false, reason: "quota_bucket_unavailable" };
  if (bucket.rateLimitReachedType != null || bucket.spendControlReached === true) return { allowed: false, reason: "quota_restricted" };
  let snapshot;
  try { snapshot = extractFiveHourSnapshot(result, { limitId, observedAtMs }); }
  catch { return { allowed: false, reason: "five_hour_window_unavailable" }; }
  const windows = [bucket.primary, bucket.secondary];
  const longer = windows.filter((window) => Number.isSafeInteger(window?.windowDurationMins) && window.windowDurationMins > 300);
  if (longer.length !== 1 || typeof longer[0].usedPercent !== "number" || !Number.isFinite(longer[0].usedPercent) ||
      longer[0].usedPercent < 0 || longer[0].usedPercent >= 100 || !Number.isSafeInteger(longer[0].resetsAt) ||
      !Number.isSafeInteger(longer[0].resetsAt * 1000) || longer[0].resetsAt * 1000 < observedAtMs) return { allowed: false, reason: "longer_window_unavailable_or_exhausted" };
  if (snapshot.usedPercent !== 0) return { allowed: false, reason: "window_already_in_use" };
  return { allowed: true, reason: "no_quota_veto", snapshot };
}
