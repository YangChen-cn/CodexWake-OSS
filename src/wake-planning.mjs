import { ACTIVITY_GRACE_MS, WAKE_TTL_MS } from "./activity-policy.mjs";

export const WINDOW_MS = 5 * 60 * 60000;
const DAY_MS = 24 * 60 * 60000;
const periods = { none: 0, daily: DAY_MS, weekly: 7 * DAY_MS };

export function validateAppointments(items, nowMs) {
  if (!Array.isArray(items) || items.length > 20) throw new Error("At most 20 appointments");
  const ids = new Set();
  return items.map((item) => {
    if (!item || Object.keys(item).sort().join(",") !== "endAtMs,id,recoveryMinutes,repeat,startAtMs" ||
        typeof item.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.id) || ids.has(item.id) ||
        !Number.isSafeInteger(item.startAtMs) || item.startAtMs <= 0 || item.startAtMs > nowMs + 366 * DAY_MS ||
        !Number.isSafeInteger(item.endAtMs) || item.endAtMs <= item.startAtMs || item.endAtMs - item.startAtMs > DAY_MS ||
        !Object.hasOwn(periods, item.repeat) ||
        !(item.recoveryMinutes === null || Number.isInteger(item.recoveryMinutes) && item.recoveryMinutes >= 0 && item.recoveryMinutes <= 300)) {
      throw new Error("Invalid appointment");
    }
    ids.add(item.id);
    return { ...item };
  });
}

export function nextAppointment(item, nowMs, consumedStart) {
  const period = periods[item.repeat];
  let index = 0;
  if (period) {
    index = Math.max(0, Math.floor((nowMs - item.endAtMs) / period) + 1,
      consumedStart == null ? 0 : Math.floor((consumedStart - item.startAtMs) / period) + 1);
  }
  const startAtMs = item.startAtMs + index * period;
  const endAtMs = item.endAtMs + index * period;
  if (endAtMs <= nowMs || startAtMs <= (consumedStart ?? 0)) return null;
  const idealAtMs = item.recoveryMinutes === null ? startAtMs : startAtMs + item.recoveryMinutes * 60000 - WINDOW_MS;
  return { source: "appointment", key: `appointment:${item.id}:${startAtMs}`, id: item.id, startAtMs, endAtMs, idealAtMs };
}

export function planWakes(state, nowMs, activityStatus = "armed") {
  const observedReset = state.activityWake?.resetAtMs ?? 0;
  const estimate = state.lastActivation?.outcome === "completed_unverified"
    ? Math.max(state.lastActivation.finishedAtMs, state.lastWakeReportedAtMs ?? 0) + WINDOW_MS : 0;
  const resetAtMs = Math.max(observedReset, estimate);
  const notBefore = resetAtMs ? resetAtMs + ACTIVITY_GRACE_MS : 0;
  const candidates = [];
  const activity = state.activityWake;
  const limit = state.config.maxIdleWakes ?? 2;
  if (activity?.status === activityStatus && activity.windowKey === `codex:300:${observedReset}` &&
      observedReset > 0 && nowMs < observedReset + WAKE_TTL_MS && (state.idleWakes ?? 0) < limit) {
    candidates.push({ source: "user_activity", key: activity.windowKey, dueAtMs: notBefore,
      expiresAtMs: observedReset + WAKE_TTL_MS });
  }
  const continuation = state.continuation;
  if (continuation && nowMs < continuation.expiresAtMs && (state.idleWakes ?? 0) < limit) {
    candidates.push({ ...continuation, dueAtMs: Math.max(continuation.dueAtMs, notBefore) });
  }
  const appointments = (state.appointments ?? []).map((item) => {
    const occurrence = nextAppointment(item, nowMs, state.usedAppointments?.[item.id]);
    if (!occurrence) return { ...item, next: null };
    const dueAtMs = Math.max(occurrence.idealAtMs, notBefore);
    const lastFinished = state.lastActivation?.outcome === "completed_unverified" ? state.lastActivation.finishedAtMs : 0;
    const covered = lastFinished >= occurrence.idealAtMs && lastFinished < occurrence.endAtMs;
    const eligible = dueAtMs < occurrence.endAtMs && !covered;
    if (eligible) candidates.push({ ...occurrence, dueAtMs, expiresAtMs: occurrence.endAtMs });
    return { ...item, next: { ...occurrence, dueAtMs, reason: covered ? "appointment_covered" : eligible ? null : "appointment_window_unavailable" } };
  });
  candidates.sort((a, b) => a.dueAtMs - b.dueAtMs);
  return { candidates, appointments, resetAtMs: resetAtMs || null, resetSource: !resetAtMs ? null : estimate > observedReset ? "estimated" : "observed" };
}

export function consumeWake(state, wake, reason) {
  if (!wake) return {};
  if (wake.source === "appointment") {
    return { usedAppointments: { ...state.usedAppointments, [wake.id]: wake.startAtMs } };
  }
  if (wake.source === "rolling") return { continuation: null };
  return { activityWake: { ...state.activityWake, status: reason === "permit_issued" ? "consumed" : "canceled", reason } };
}
