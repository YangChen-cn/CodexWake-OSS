import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { initialConservativeWindow, nextConservativeWindow, evaluateConservativeWindow, FIVE_HOURS_MS, DEFAULT_MARGIN_MS } from "../src/conservative-window.mjs";

const start = Date.parse("2026-11-05T00:00:00Z"); // 08:00 Hong Kong
const config = { ...DEFAULT_CONFIG, autoEnabled: true };

test("an unknown initial window waits five hours plus margin and requires explicit acknowledgement", () => {
  assert.throws(() => initialConservativeWindow({ nowMs: start, acknowledged: false }));
  const estimate = initialConservativeWindow({ nowMs: start, acknowledged: true });
  assert.equal(estimate.notBeforeMs, start + FIVE_HOURS_MS + DEFAULT_MARGIN_MS);
  assert.equal(evaluateConservativeWindow({ config, estimate, acknowledged: true, nowMs: estimate.notBeforeMs - 1 }).candidate, false);
  assert.equal(evaluateConservativeWindow({ config, estimate, acknowledged: true, nowMs: estimate.notBeforeMs }).candidate, true);
  assert.equal(evaluateConservativeWindow({ config, estimate, acknowledged: false, nowMs: estimate.notBeforeMs }).reason, "assumptions_not_acknowledged");
});

test("next estimate uses the later of actual completion and server report, never dispatch time", () => {
  const estimate = nextConservativeWindow({ startedAtMs: start, finishedAtMs: start + 20000, reportedAtMs: start + 40000 });
  assert.equal(estimate.anchorMs, start + 40000);
  assert.equal(estimate.notBeforeMs, start + 40000 + FIVE_HOURS_MS + DEFAULT_MARGIN_MS);
  assert.throws(() => nextConservativeWindow({ startedAtMs: start, finishedAtMs: start + 50000, reportedAtMs: start + 10000 }));
});

test("sleep, disabled switches, and forged shorter estimates fail closed", () => {
  const estimate = initialConservativeWindow({ nowMs: start, acknowledged: true });
  const due = estimate.notBeforeMs;
  assert.equal(evaluateConservativeWindow({ config: { ...config, autoEnabled: false }, estimate, acknowledged: true, nowMs: due }).reason, "disabled");
  assert.equal(evaluateConservativeWindow({ config, estimate, acknowledged: true, nowMs: Date.parse("2026-11-05T16:00:00Z") }).reason, "sleeping");
  assert.equal(evaluateConservativeWindow({ config, estimate: { ...estimate, notBeforeMs: start }, acknowledged: true, nowMs: due }).reason, "invalid_estimate");
});
