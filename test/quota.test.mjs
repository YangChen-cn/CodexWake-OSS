import test from "node:test";
import assert from "node:assert/strict";
import { extractFiveHourSnapshot } from "../src/quota.mjs";

const observedAtMs = 1800000000000;
const window = { windowDurationMins: 300, resetsAt: 1800000100, usedPercent: 25 };

test("selects the named five-hour window from the multi-bucket response", () => {
  const result = { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { windowDurationMins: 10080 }, secondary: window },
    other: { limitId: "other", primary: window } } };
  assert.deepEqual(extractFiveHourSnapshot(result, { limitId: "codex", observedAtMs }), {
    source: "account/rateLimits/read", limitId: "codex", windowDurationMins: 300,
    observedAtMs, resetAtMs: 1800000100000, usedPercent: 25,
  });
});

test("supports the legacy single-bucket response", () => {
  assert.equal(extractFiveHourSnapshot({ rateLimits: { limitId: "codex", primary: window } },
    { limitId: "codex", observedAtMs }).resetAtMs, 1800000100000);
});

test("rejects missing, ambiguous, incomplete, and stale quota data", () => {
  for (const bucket of [null, { primary: window, secondary: window },
    { primary: { ...window, usedPercent: null } }, { primary: { ...window, resetsAt: 1799999999 } },
    { primary: { ...window, resetsAt: null } }]) {
    assert.throws(() => extractFiveHourSnapshot({ rateLimitsByLimitId: { codex: bucket } }, { limitId: "codex", observedAtMs }));
  }
});
