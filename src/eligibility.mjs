import { evaluateSchedule } from "./policy.mjs";

// Only decides whether a Runner preflight is due. It does not prove that the
// current window is inactive: other clients may have changed the account.
// The caller must ensure snapshots came from an authenticated Runner; the
// source label below is metadata, not proof of authenticity.
export function evaluateEligibility({ config, now, snapshot, graceMs = 120000 }) {
  const schedule = evaluateSchedule(config, now);
  if (!schedule.permitted) return { candidate: false, reason: schedule.reason };
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 3600000) {
    return { candidate: false, reason: "invalid_grace" };
  }
  const nowMs = now.getTime();
  if (!snapshot || snapshot.source !== "account/rateLimits/read" ||
      snapshot.windowDurationMins !== 300 || !Number.isSafeInteger(snapshot.observedAtMs) ||
      !Number.isSafeInteger(snapshot.resetAtMs) || snapshot.observedAtMs < 0 ||
      snapshot.observedAtMs > nowMs || snapshot.resetAtMs < snapshot.observedAtMs ||
      !Number.isSafeInteger(snapshot.resetAtMs + graceMs)) {
    return { candidate: false, reason: "no_trustworthy_reset" };
  }
  const dueAtMs = snapshot.resetAtMs + graceMs;
  if (nowMs < dueAtMs) return { candidate: false, reason: "waiting_for_reset", dueAtMs };
  return { candidate: true, reason: "preflight_due", dueAtMs };
}
