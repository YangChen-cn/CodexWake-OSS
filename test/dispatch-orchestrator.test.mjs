import test from "node:test";
import assert from "node:assert/strict";
import { dispatchDuePreflight, dispatchManualProbe, dispatchActivityWake } from "../src/dispatch-orchestrator.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { initialState, readState } from "../src/state.mjs";
import { initialConservativeWindow } from "../src/conservative-window.mjs";

function storageFake(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    get: async () => structuredClone(value),
    transaction(callback) {
      const run = tail.then(async () => {
        let pending = structuredClone(value);
        const result = await callback({ get: async () => structuredClone(pending), put: async (_key, next) => { pending = structuredClone(next); } });
        value = pending;
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}
const nowMs = Date.parse("2026-11-04T04:00:00Z");
const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const ready = { ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true },
  credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd", quotaSnapshot: {
    source: "account/rateLimits/read", windowDurationMins: 300, observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000,
  } };

test("competing ticks dispatch only once after durable reservation", async () => {
  const storage = storageFake(ready);
  let calls = 0;
  const dispatch = async () => { calls++; assert.equal((await readState(storage)).phase, "DISPATCHING"); return { outcome: "accepted", runId: "101" }; };
  const results = await Promise.all([
    dispatchDuePreflight(storage, { githubConfig: {}, nowMs, attemptId }, { dispatch }),
    dispatchDuePreflight(storage, { githubConfig: {}, nowMs, attemptId: "51c854e8-23cc-4d57-8e1a-3078a9fd28d7" }, { dispatch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((result) => result.outcome === "accepted").length, 1);
  assert.equal((await readState(storage)).attempt.dispatch.runId, "101");
});

test("a lost dispatch response stays blocked on later ticks", async () => {
  const storage = storageFake(ready);
  let calls = 0;
  const dispatch = async () => { calls++; throw new Error("transport unavailable"); };
  assert.equal((await dispatchDuePreflight(storage, { githubConfig: {}, nowMs, attemptId }, { dispatch })).outcome, "unknown");
  assert.equal((await dispatchDuePreflight(storage, { githubConfig: {}, nowMs, attemptId }, { dispatch })).reason, "in_flight");
  assert.equal(calls, 1);
  assert.equal((await readState(storage)).attempt.dispatch.outcome, "unknown");
});

test("disabled or premature runs do not call GitHub", async () => {
  const storage = storageFake({ ...ready, config: DEFAULT_CONFIG });
  const result = await dispatchDuePreflight(storage, { githubConfig: {}, nowMs, attemptId },
    { dispatch: async () => { throw new Error("unexpected"); } });
  assert.deepEqual(result, { outcome: "skipped", reason: "disabled" });
});

test("manual probe can dispatch once without a quota snapshot", async () => {
  const storage = storageFake({ ...initialState(), credentialGeneration: ready.credentialGeneration });
  let calls = 0;
  const result = await dispatchManualProbe(storage, { githubConfig: {}, nowMs, attemptId, expectedRevision: 0 }, {
    dispatch: async () => { calls++; return { outcome: "accepted", runId: "101" }; },
  });
  assert.equal(result.outcome, "accepted");
  assert.equal((await readState(storage)).attempt.kind, "manual_probe");
  await assert.rejects(dispatchManualProbe(storage, { githubConfig: {}, nowMs, attemptId, expectedRevision: 1 }, {
    dispatch: async () => { calls++; },
  }), /revision|busy/);
  assert.equal(calls, 1);
});

test("estimated ticks never dispatch without evidence of previous-window exhaustion", async () => {
  const estimated = { ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true, model: "current-model" },
    credentialGeneration: ready.credentialGeneration, conservativeAcknowledged: true,
    conservativeEstimate: initialConservativeWindow({ acknowledged: true, nowMs: nowMs - 6 * 3600000 }),
    modelAttestation: { source: "local_model_list", model: "current-model", cliVersion: "0.166.0", verifiedAtMs: nowMs - 1000, expiresAtMs: nowMs + 86400000 } };
  const storage = storageFake(estimated);
  let calls = 0;
  const dispatch = async () => { calls++; return { outcome: "accepted", runId: "123" }; };
  const results = await Promise.all([
    dispatchActivityWake(storage, { githubConfig: {}, nowMs, attemptId }, { dispatch }),
    dispatchActivityWake(storage, { githubConfig: {}, nowMs, attemptId: "51c854e8-23cc-4d57-8e1a-3078a9fd28d7" }, { dispatch }),
  ]);
  assert.equal(calls, 0);
  assert.deepEqual(results.map((result) => result.reason), ["no_pending_activity", "no_pending_activity"]);
  assert.equal((await readState(storage)).attempt, null);
});
