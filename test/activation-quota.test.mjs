import test from "node:test";
import assert from "node:assert/strict";
import { assessActivationQuota } from "../src/activation-quota.mjs";

const observedAtMs = 1800000000000;
const five = { windowDurationMins: 300, resetsAt: 1800018000, usedPercent: 0 };
const longer = { windowDurationMins: 10080, resetsAt: 1800604800, usedPercent: 5 };
const result = { ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: { limitId: "codex", primary: five, secondary: longer } } };
const assess = (value) => assessActivationQuota(value, { limitId: "codex", observedAtMs });

test("fresh quota can avoid a veto without claiming that a window started", () => {
  const assessment = assess(result);
  assert.equal(assessment.allowed, true);
  assert.equal(assessment.reason, "no_quota_veto");
  assert.equal(assessment.snapshot.source, "account/rateLimits/read");
  assert.equal(Object.hasOwn(assessment, "windowStarted"), false);
});

test("unknown ordinary usage, longer limits, and known consumption veto activation", () => {
  assert.equal(assess({ ...result, ordinaryUsageAllowed: null }).reason, "ordinary_usage_unconfirmed");
  assert.equal(assess({ ...result, ordinaryUsageAllowed: false }).allowed, false);
  for (const change of [{ primary: { ...five, usedPercent: 2 } }, { secondary: null },
    { secondary: { ...longer, usedPercent: 100 } }, { spendControlReached: true }, { rateLimitReachedType: "rate_limit_reached" }]) {
    const value = { ...result, rateLimitsByLimitId: { codex: { ...result.rateLimitsByLimitId.codex, ...change } } };
    assert.equal(assess(value).allowed, false);
  }
});
