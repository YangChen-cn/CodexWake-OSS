import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { evaluateEligibility } from "../src/eligibility.mjs";

const config = { ...DEFAULT_CONFIG, autoEnabled: true };
const now = new Date("2026-11-04T04:00:00Z");
const snapshot = {
  source: "account/rateLimits/read", windowDurationMins: 300,
  observedAtMs: now.getTime() - 3600000, resetAtMs: now.getTime() - 120000,
};

test("a verified-looking snapshot schedules preflight at reset plus grace", () => {
  assert.equal(evaluateEligibility({ config, now, snapshot }).reason, "preflight_due");
  assert.equal(evaluateEligibility({ config, now: new Date(now.getTime() - 1), snapshot }).reason, "waiting_for_reset");
});

test("a preflight is never due when disabled or sleeping", () => {
  assert.equal(evaluateEligibility({ config: DEFAULT_CONFIG, now, snapshot }).reason, "disabled");
  assert.equal(evaluateEligibility({ config, now: new Date("2026-11-04T16:00:00Z"), snapshot }).reason, "sleeping");
});

test("missing, future, estimated and non-five-hour snapshots fail closed", () => {
  for (const candidate of [undefined, { ...snapshot, source: "manual" },
    { ...snapshot, windowDurationMins: 60 }, { ...snapshot, observedAtMs: now.getTime() + 1 },
    { ...snapshot, resetAtMs: snapshot.observedAtMs - 1 }]) {
    assert.equal(evaluateEligibility({ config, now, snapshot: candidate }).reason, "no_trustworthy_reset");
  }
});
