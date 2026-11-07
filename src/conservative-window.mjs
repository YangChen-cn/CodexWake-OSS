import { evaluateSchedule } from "./policy.mjs";

// This is an explicitly acknowledged estimate, not a live quota observation.
// It is safe only under the documented single-account-activity assumption:
// another client must not start a window after the estimated reset and before
// this service's next activation. Never enable it implicitly.
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_MARGIN_MS = 2 * 60 * 1000;

function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function checkedDue(anchorMs, marginMs) {
  if (!validTime(anchorMs) || !Number.isSafeInteger(marginMs) || marginMs < DEFAULT_MARGIN_MS || marginMs > 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(anchorMs + FIVE_HOURS_MS + marginMs)) throw new Error("Invalid conservative window");
  return anchorMs + FIVE_HOURS_MS + marginMs;
}

// When the previous window is unknown, wait a complete five hours from the
// server's enrollment time. This is not proof of inactivity if another
// client uses the account during the waiting period.
export function initialConservativeWindow({ nowMs, acknowledged, marginMs = DEFAULT_MARGIN_MS }) {
  if (acknowledged !== true) throw new Error("Conservative assumptions must be acknowledged");
  return { source: "conservative_estimate", anchorMs: nowMs, notBeforeMs: checkedDue(nowMs, marginMs), marginMs };
}

// Use server-side report time as a conservative upper bound as well as the
// actual Runner completion time. A lost or failed turn must never call this.
export function nextConservativeWindow({ startedAtMs, finishedAtMs, reportedAtMs, marginMs = DEFAULT_MARGIN_MS }) {
  if (![startedAtMs, finishedAtMs, reportedAtMs].every(validTime) || startedAtMs > finishedAtMs ||
      finishedAtMs > reportedAtMs + 30000 || reportedAtMs - startedAtMs > 30 * 60 * 1000 ||
      startedAtMs > reportedAtMs + 30000) throw new Error("Unreliable activation timestamps");
  const anchorMs = Math.max(finishedAtMs, reportedAtMs);
  return { source: "conservative_estimate", anchorMs, notBeforeMs: checkedDue(anchorMs, marginMs), marginMs };
}

export function evaluateConservativeWindow({ config, estimate, acknowledged, nowMs }) {
  if (acknowledged !== true) return { candidate: false, reason: "assumptions_not_acknowledged" };
  if (!validTime(nowMs)) return { candidate: false, reason: "invalid_time" };
  const schedule = evaluateSchedule(config, new Date(nowMs));
  if (!schedule.permitted) return { candidate: false, reason: schedule.reason };
  if (!estimate || estimate.source !== "conservative_estimate" || !validTime(estimate.anchorMs) ||
      !Number.isSafeInteger(estimate.marginMs) || !validTime(estimate.notBeforeMs)) {
    return { candidate: false, reason: "estimate_unavailable" };
  }
  try {
    if (checkedDue(estimate.anchorMs, estimate.marginMs) !== estimate.notBeforeMs || estimate.anchorMs > nowMs) {
      return { candidate: false, reason: "invalid_estimate" };
    }
  } catch { return { candidate: false, reason: "invalid_estimate" }; }
  if (nowMs < estimate.notBeforeMs) return { candidate: false, reason: "waiting_for_estimate", dueAtMs: estimate.notBeforeMs };
  return { candidate: true, reason: "estimated_preflight_due", dueAtMs: estimate.notBeforeMs };
}
