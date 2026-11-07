import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { initialState } from "../src/state.mjs";
import { ACTIVITY_GRACE_MS, WAKE_TTL_MS } from "../src/activity-policy.mjs";

const start = Date.parse("2026-11-06T02:00:00Z"); // 10:00 Hong Kong
const hours = (count) => count * 60 * 60 * 1000;
const accountTag = "a".repeat(64);
const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const model = "current-test-model";
const state = { ...initialState(), credentialGeneration: generation,
  config: { ...DEFAULT_CONFIG, model, autoEnabled: true },
  modelAttestation: { source: "local_model_list", model, cliVersion: "0.166.0", verifiedAtMs: start - 1000 } };

function event(at, reset, usedPercent = 20) {
  return { version: 1, eventKind: "user_activity", accountTag, activityAtMs: at, observedAtMs: at + 100,
    eventId: createHash("sha256").update(randomUUID()).digest("hex"), resetAtMs: reset,
    weekResetAtMs: at + hours(96), windowDurationMins: 300, limitId: "codex", windowKey: `codex:300:${reset}`, usedPercent };
}

async function fixture(t) {
  const paths = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs",
    "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"];
  const modules = paths.map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)), durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  t.after(() => mf.dispose());
  const call = (operation, args, extra) => mf.dispatchFetch("http://test/", {
    method: "POST", body: JSON.stringify({ operation, args, ...extra }),
  });
  await call("seed", null, { state });
  const value = async (...args) => {
    const response = await call(...args);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { call, value };
}

test("SQLite consumes a real-use window once under concurrent events, Cron and Runner calls", async (t) => {
  const { call, value } = await fixture(t);
  const reset = start + hours(5);
  const due = reset + ACTIVITY_GRACE_MS;
  const e = event(start, reset);
  const args = { event: e, nowMs: e.observedAtMs };
  const noActivity = await value("reserve-activity", { attemptId: randomUUID(), nowMs: start });
  assert.equal(noActivity.reason, "no_pending_activity");
  assert.equal((await call("local-activity", { ...args, event: { ...e, limitId: "other" } })).status, 409);
  assert.equal((await call("local-activity", { ...args, nowMs: reset })).status, 409);
  const reports = await Promise.all(Array.from({ length: 10 }, () => value("local-activity", args)));
  assert.equal(reports.filter((report) => report.outcome === "armed").length, 1);
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: reset + 1 })).reason, "waiting_for_reset");
  const attempts = await Promise.all(Array.from({ length: 6 }, async () => {
    const attemptId = randomUUID();
    return { attemptId, ...(await value("reserve-activity", { attemptId, nowMs: due })) };
  }));
  assert.equal(attempts.filter(({ reason }) => reason === null).length, 1);
  const { attemptId } = attempts.find(({ reason }) => reason === null);
  const identity = { runId: "101", runAttempt: "1" };
  await value("dispatch-outcome", { attemptId, outcome: "accepted", runId: identity.runId });
  await value("claim", { attemptId, identity, credentialGeneration: generation, nowMs: due });
  const authorize = { attemptId, identity, models: [], cliVersion: "0.166.0", accountTag, activityWakesEnabled: true, nowMs: due };
  assert.equal((await call("authorize-activation", { ...authorize, accountTag: "b".repeat(64) })).status, 409);
  const permits = await Promise.all([call("authorize-activation", authorize), call("authorize-activation", authorize)]);
  assert.deepEqual(permits.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await call("skip-activity", { attemptId, identity })).status, 409, "lost permit must not release lock");
  await value("complete-activation", { attemptId, identity, startedAtMs: due, finishedAtMs: due + 500,
    nowMs: due + 500, outcome: "completed_unverified" });
  assert.equal((await value("read")).activityWake.status, "consumed");
  assert.equal((await value("read")).conservativeEstimate, undefined);
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: due + hours(72) })).reason, "no_pending_activity");
  const realUse = event(due + hours(3), due + hours(5), 95);
  assert.equal((await value("local-activity", { event: realUse, nowMs: realUse.observedAtMs })).outcome, "armed");
});

test("SQLite defers overnight, expires stale arms, and cancels before a delayed Runner's permit", async (t) => {
  const { call, value } = await fixture(t);
  const at = start + hours(12);
  const reset = start + hours(15); // 01:00 HKT
  const e = event(at, reset, 30);
  await value("local-activity", { event: e, nowMs: e.observedAtMs });
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: reset + ACTIVITY_GRACE_MS })).reason, "sleeping");
  const morning = start + hours(22);
  const attemptId = randomUUID();
  assert.equal((await value("reserve-activity", { attemptId, nowMs: morning })).reason, null);
  const identity = { runId: "101", runAttempt: "1" };
  await value("dispatch-outcome", { attemptId, outcome: "accepted", runId: identity.runId });
  const before = await value("read");
  await value("cancel-activity", { expectedRevision: before.revision, nowMs: morning });
  await value("claim", { attemptId, identity, credentialGeneration: generation, nowMs: morning });
  assert.equal((await call("authorize-activation", { attemptId, identity, models: [], cliVersion: "0.166.0", accountTag,
    activityWakesEnabled: true, nowMs: morning })).status, 409);
  await value("skip-activity", { attemptId, identity });
  assert.equal((await value("read")).phase, "WAITING");
  const later = event(morning + 1000, morning + hours(5), 30);
  await value("local-activity", { event: later, nowMs: later.observedAtMs });
  const expiry = later.resetAtMs + WAKE_TTL_MS;
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: expiry })).reason, "activity_expired");
  assert.equal((await value("read")).activityWake.status, "expired");
});

test("SQLite caps rolling at two and a new real window resets the count", async (t) => {
  const { value } = await fixture(t);
  const reset = start + hours(5);
  const e = event(start, reset, 30);
  await value("local-activity", { event: e, nowMs: e.observedAtMs });
  async function wake(nowMs, runId) {
    const attemptId = randomUUID();
    const identity = { runId, runAttempt: "1" };
    assert.equal((await value("reserve-activity", { attemptId, nowMs })).reason, null);
    await value("dispatch-outcome", { attemptId, outcome: "accepted", runId });
    await value("claim", { attemptId, identity, credentialGeneration: generation, nowMs });
    await value("authorize-activation", { attemptId, identity, models: [], cliVersion: "0.166.0", accountTag,
      activityWakesEnabled: true, nowMs });
    await value("complete-activation", { attemptId, identity, startedAtMs: nowMs, finishedAtMs: nowMs + 500,
      nowMs: nowMs + 500, outcome: "completed_unverified" });
  }
  const first = reset + ACTIVITY_GRACE_MS;
  await wake(first, "101");
  assert.equal((await value("read")).idleWakes, 1);
  const second = first + 500 + hours(5) + ACTIVITY_GRACE_MS;
  await wake(second, "102");
  const rolled = await value("read");
  assert.equal(rolled.idleWakes, 2);
  assert.equal(rolled.lastActivityWake.source, "rolling");
  const tomorrow = start + hours(24);
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: tomorrow })).reason, "no_pending_activity");
  const next = event(tomorrow, tomorrow + hours(5), 20);
  await value("local-activity", { event: next, nowMs: next.observedAtMs });
  assert.equal((await value("read")).idleWakes, 0);
});

test("SQLite appointment is cloud-owned and cancellation fences an already queued Runner", async (t) => {
  const { value, call } = await fixture(t);
  const item = { id: randomUUID(), startAtMs: start + hours(11), endAtMs: start + hours(13),
    recoveryMinutes: 60, repeat: "none" };
  await value("appointments", { appointments: [item], expectedRevision: 0, nowMs: start });
  assert.equal((await call("appointments", { appointments: [], expectedRevision: 0, nowMs: start })).status, 409);
  const due = start + hours(7);
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: due - 1 })).reason, "waiting_for_reset");
  const attemptId = randomUUID();
  assert.equal((await value("reserve-activity", { attemptId, nowMs: due })).reason, null);
  const identity = { runId: "201", runAttempt: "1" };
  await value("dispatch-outcome", { attemptId, outcome: "accepted", runId: identity.runId });
  await value("claim", { attemptId, identity, credentialGeneration: generation, nowMs: due });
  const { revision } = await value("read");
  await value("cancel-activity", { expectedRevision: revision, nowMs: due });
  assert.equal((await call("authorize-activation", { attemptId, identity, models: [], cliVersion: "0.166.0", accountTag,
    activityWakesEnabled: true, nowMs: due })).status, 409);
  await value("skip-activity", { attemptId, identity });
  assert.equal((await value("reserve-activity", { attemptId: randomUUID(), nowMs: due + 1000 })).reason, "no_pending_activity");
});
