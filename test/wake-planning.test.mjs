import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { planWakes, validateAppointments } from "../src/wake-planning.mjs";
import { ACTIVITY_GRACE_MS } from "../src/activity-policy.mjs";

test("appointment works backward from recovery target and honors observed reset and occurrence consumption", () => {
  const hour = 3600000;
  const startAtMs = Date.parse("2026-11-08T13:00:00Z"); // 21:00 HKT
  const now = startAtMs - 6 * hour;
  const appointment = { id: randomUUID(), startAtMs, endAtMs: startAtMs + 2 * hour, recoveryMinutes: 60, repeat: "daily" };
  const state = { config: DEFAULT_CONFIG, appointments: validateAppointments([appointment], now) };
  assert.equal(planWakes(state, now).candidates[0].dueAtMs, startAtMs - 4 * hour);
  state.activityWake = { resetAtMs: startAtMs - hour };
  assert.equal(planWakes(state, now).candidates[0].dueAtMs, startAtMs - hour + ACTIVITY_GRACE_MS);
  state.usedAppointments = { [appointment.id]: startAtMs };
  assert.equal(planWakes(state, now).candidates[0].startAtMs, startAtMs + 24 * hour);
  state.usedAppointments = {};
  state.lastActivation = { outcome: "completed_unverified", finishedAtMs: startAtMs - 3 * hour };
  assert.equal(planWakes(state, now).candidates.length, 0);
  assert.equal(planWakes(state, now).appointments[0].next.reason, "appointment_covered");
});
