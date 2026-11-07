import { evaluateSchedule } from "./policy.mjs";

export const ACTIVITY_GRACE_MS = 120000;
export const ACTIVITY_MAX_AGE_MS = 120000;
export const WAKE_TTL_MS = 12 * 60 * 60 * 1000;
export const ACTIVITY_BLOCK = "activity_wakes_not_enabled";

export function activityEnabled(env) {
  return env.ACTIVATION_ENABLED === "true" && env.ACTIVITY_WAKES_ENABLED === "true" &&
    /^[A-Za-z0-9_-]{43}$/.test(env.ACTIVITY_REPORT_TOKEN ?? "") && env.ACTIVITY_REPORT_TOKEN !== env.ADMIN_TOKEN;
}

export function validateActivity(event, nowMs) {
  if (!event || typeof event !== "object" ||
      Object.keys(event).sort().join(",") !== "accountTag,activityAtMs,eventId,eventKind,limitId,observedAtMs,resetAtMs,usedPercent,version,weekResetAtMs,windowDurationMins,windowKey" ||
      event.version !== 1 || event.eventKind !== "user_activity" || event.limitId !== "codex" || event.windowDurationMins !== 300 ||
      typeof event.eventId !== "string" || !/^[a-f0-9]{64}$/.test(event.eventId) ||
      typeof event.accountTag !== "string" || !/^[a-f0-9]{64}$/.test(event.accountTag) ||
      ![event.activityAtMs, event.observedAtMs, event.resetAtMs, event.weekResetAtMs].every((value) => Number.isSafeInteger(value) && value > 0) ||
      event.activityAtMs > event.observedAtMs || nowMs - event.activityAtMs > ACTIVITY_MAX_AGE_MS ||
      event.observedAtMs > nowMs + 10000 || event.resetAtMs <= Math.max(event.observedAtMs, nowMs) ||
      event.resetAtMs > event.activityAtMs + 300 * 60000 + 30000 ||
      event.weekResetAtMs <= event.observedAtMs || event.weekResetAtMs > event.observedAtMs + 10080 * 60000 ||
      event.windowKey !== `codex:300:${event.resetAtMs}` ||
      !Number.isFinite(event.usedPercent) || event.usedPercent <= 0 || event.usedPercent > 100) {
    throw new Error("Invalid or stale activity evidence");
  }
  return event;
}

export function evaluateActivityWake(state, nowMs, expectedStatus = "armed") {
  const schedule = evaluateSchedule(state.config, new Date(nowMs));
  if (!state.config.autoEnabled) return schedule.reason;
  const arm = state.activityWake;
  if (!arm || arm.status !== expectedStatus) return "no_pending_activity";
  if (!Number.isSafeInteger(arm.resetAtMs) || arm.resetAtMs < 1 || arm.limitId !== "codex" ||
      arm.windowKey !== `codex:300:${arm.resetAtMs}`) return "invalid_activity_window";
  if (nowMs >= arm.resetAtMs + WAKE_TTL_MS) return "activity_expired";
  if (nowMs < arm.resetAtMs + ACTIVITY_GRACE_MS) return "waiting_for_reset";
  if (!schedule.permitted) return schedule.reason;
  return null;
}

export async function accountTag(auth) {
  const id = auth?.tokens?.account_id;
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("ChatGPT account identity unavailable");
  const bytes = new TextEncoder().encode(`codexwake-account-v1:${id.toLowerCase()}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
