import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, evaluateSchedule, validateConfig } from "../src/policy.mjs";
import { Coordinator } from "../src/coordinator.mjs";
import { initialState } from "../src/state.mjs";

const enabled = { ...DEFAULT_CONFIG, autoEnabled: true };
const at = (iso) => new Date(iso);

test("disabled by default", () => {
  assert.deepEqual(evaluateSchedule(DEFAULT_CONFIG, at("2026-11-04T01:00:00Z")), {
    permitted: false, reason: "disabled",
  });
  assert.equal(evaluateSchedule({ ...DEFAULT_CONFIG, autoEnabled: "true" }, at("2026-11-04T01:00:00Z")).permitted, false);
});

test("Hong Kong intervals use inclusive start and exclusive end", () => {
  assert.equal(evaluateSchedule(enabled, at("2026-11-04T00:00:00Z")).permitted, true); // 08:00
  assert.equal(evaluateSchedule(enabled, at("2026-11-04T14:59:00Z")).permitted, true); // 22:59
  assert.equal(evaluateSchedule(enabled, at("2026-11-04T15:00:00Z")).reason, "sleeping"); // 23:00
  assert.equal(evaluateSchedule(enabled, at("2026-11-03T23:59:00Z")).reason, "sleeping"); // 07:59
});

test("cross-midnight allowed hours and sleep precedence", () => {
  const config = { ...enabled, allowedStart: "22:00", allowedEnd: "06:00", sleepStart: "01:00", sleepEnd: "03:00" };
  assert.equal(evaluateSchedule(config, at("2026-11-04T16:30:00Z")).permitted, true); // 00:30
  assert.equal(evaluateSchedule(config, at("2026-11-04T18:00:00Z")).reason, "sleeping"); // 02:00
  assert.equal(evaluateSchedule(config, at("2026-11-04T22:00:00Z")).reason, "outside_allowed_hours"); // 06:00
});

test("invalid settings fail closed", () => {
  for (const config of [
    { ...enabled, timeZone: "Not/AZone" },
    { ...enabled, sleepStart: "12:00", sleepEnd: "12:00" },
    { ...enabled, allowedEnd: "24:00" },
  ]) assert.equal(evaluateSchedule(config, at("2026-11-04T01:00:00Z")).reason, "invalid_configuration");
});

test("configuration validation rejects misspelled keys and invalid values", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  for (const config of [
    { ...DEFAULT_CONFIG, autoEnabld: true },
    { ...DEFAULT_CONFIG, maxRetries: -1 },
    { ...DEFAULT_CONFIG, retryIntervalMinutes: 0 },
    { ...DEFAULT_CONFIG, model: " " },
    { ...DEFAULT_CONFIG, activationMessage: "" },
    { ...DEFAULT_CONFIG, timeZone: "Not/AZone" },
    { ...DEFAULT_CONFIG, allowedStart: "08:00", allowedEnd: "08:00" },
  ]) assert.throws(() => validateConfig(config));
});

test("coordinator tick remains non-dispatching even if enabled", async () => {
  const coordinator = new Coordinator({ storage: { get: async () => ({ ...initialState(), config: enabled }) } });
  const response = await coordinator.fetch(new Request("https://internal/tick", { method: "POST" }));
  const body = await response.json();
  assert.equal(body.state, "WAITING");
  assert.equal(body.dispatchImplemented, false);
});
