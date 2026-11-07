import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { STATE_KEY, initialState, readState, replaceConfig, reservePreflight, claimPreflight,
  prepareCredentialRotation, commitCredentialRotation, recordDispatchOutcome, completePreflight,
  prepareCredentialBootstrap, commitCredentialBootstrap, authorizeBootstrapWrite, authorizeCredentialWrite, reserveManualProbe } from "../src/state.mjs";

// Minimal serialized transaction fake: each transaction sees the committed
// state after the preceding transaction finishes, like the coordinator store.
function storageFake(initial = undefined) {
  let value = initial;
  let tail = Promise.resolve();
  return {
    async get(key) { assert.equal(key, STATE_KEY); return structuredClone(value); },
    transaction(callback) {
      const run = tail.then(async () => {
        let pending = structuredClone(value);
        const result = await callback({
          get: async () => structuredClone(pending),
          put: async (key, next) => { assert.equal(key, STATE_KEY); pending = structuredClone(next); },
        });
        value = pending;
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}

test("initial state is disabled and reading it does not require a write", async () => {
  const state = await readState(storageFake());
  assert.deepEqual(state, initialState());
  assert.equal(state.config.autoEnabled, false);
});

test("concurrent config updates with the same revision cannot overwrite each other", async () => {
  const storage = storageFake();
  const updates = await Promise.allSettled([
    replaceConfig(storage, { ...DEFAULT_CONFIG, allowedStart: "09:00" }, 0),
    replaceConfig(storage, { ...DEFAULT_CONFIG, allowedStart: "10:00" }, 0),
  ]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(updates.find((result) => result.status === "rejected").reason.message, /revision conflict/);
  const state = await readState(storage);
  assert.equal(state.revision, 1);
  assert.equal(state.configGeneration, 1);
  assert.equal(state.config.allowedStart, "09:00");
});

test("corrupt state and invalid changes fail closed", async () => {
  await assert.rejects(readState(storageFake({ ...initialState(), schemaVersion: 99 })));
  await assert.rejects(readState(storageFake({ ...initialState(), phase: "DISPATCHING", attempt: { id: "broken" } })));
  const storage = storageFake();
  await assert.rejects(replaceConfig(storage, { ...DEFAULT_CONFIG, timeZone: "invalid" }, 0));
  assert.equal((await readState(storage)).revision, 0);
});

test("two simultaneous reservations create only one in-flight attempt", async () => {
  const nowMs = Date.parse("2026-11-04T04:00:00Z");
  const state = { ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true },
    credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd",
    quotaSnapshot: { source: "account/rateLimits/read", windowDurationMins: 300,
      observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000 } };
  const storage = storageFake(state);
  const results = await Promise.allSettled([
    reservePreflight(storage, { attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6", expectedRevision: 0, nowMs }),
    reservePreflight(storage, { attemptId: "51c854e8-23cc-4d57-8e1a-3078a9fd28d7", expectedRevision: 0, nowMs }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const next = await readState(storage);
  assert.equal(next.phase, "DISPATCHING");
  assert.equal(next.attempt.credentialGeneration, state.credentialGeneration);
  assert.equal(next.attempt.configGeneration, 0);
  await assert.rejects(reservePreflight(storage, {
    attemptId: "a4d82411-6583-44c1-9a42-60b512cc8bc6", expectedRevision: 1, nowMs,
  }), /already in progress/);
});

test("reservation fails closed without credentials or a due snapshot", async () => {
  const storage = storageFake();
  await assert.rejects(reservePreflight(storage, {
    attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6", expectedRevision: 0,
    nowMs: Date.parse("2026-11-04T04:00:00Z"),
  }), /Credential generation/);
  assert.equal((await readState(storage)).phase, "WAITING");
});

test("a preflight claim is bound to a single run and credential generation", async () => {
  const nowMs = Date.parse("2026-11-04T04:00:00Z");
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const storage = storageFake({ ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true },
    credentialGeneration, quotaSnapshot: { source: "account/rateLimits/read", windowDurationMins: 300,
      observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000 } });
  await reservePreflight(storage, { attemptId, expectedRevision: 0, nowMs });
  const claim = { attemptId, credentialGeneration, identity: { runId: "101", runAttempt: "1" }, nowMs };
  await assert.rejects(claimPreflight(storage, claim), /confirmed dispatch/);
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  const claimed = await claimPreflight(storage, claim);
  assert.equal(claimed.attempt.runId, "101");
  assert.equal((await claimPreflight(storage, claim)).revision, claimed.revision);
  await assert.rejects(claimPreflight(storage, { ...claim, identity: { runId: "102", runAttempt: "1" } }), /confirmed dispatch/);
  await assert.rejects(claimPreflight(storage, { ...claim, identity: { runId: "101", runAttempt: "2" } }), /Invalid/);
  await assert.rejects(claimPreflight(storage, { ...claim, credentialGeneration: "a4d82411-6583-44c1-9a42-60b512cc8bc6" }), /Stale/);
  await replaceConfig(storage, { ...DEFAULT_CONFIG, autoEnabled: false }, claimed.revision);
  await assert.rejects(claimPreflight(storage, claim), /Configuration changed/);
});

test("credential rotation is reserved, fenced, and committed even after disabling", async () => {
  const nowMs = Date.parse("2026-11-04T04:00:00Z");
  const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  const storage = storageFake({ ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true },
    credentialGeneration: from, quotaSnapshot: { source: "account/rateLimits/read", windowDurationMins: 300,
      observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000 } });
  await reservePreflight(storage, { attemptId, expectedRevision: 0, nowMs });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs });
  const prepared = await prepareCredentialRotation(storage, { attemptId, identity, from, to });
  assert.deepEqual(prepared.credentialUpdate, { from, to, writeState: "prepared" });
  assert.equal((await prepareCredentialRotation(storage, { attemptId, identity, from, to })).revision, prepared.revision);
  await assert.rejects(commitCredentialRotation(storage, { attemptId, identity: { runId: "102", runAttempt: "1" }, to }), /not owned/);
  const authorized = await authorizeCredentialWrite(storage, { attemptId, identity, to });
  await assert.rejects(authorizeCredentialWrite(storage, { attemptId, identity, to }), /not authorized/);
  await replaceConfig(storage, DEFAULT_CONFIG, authorized.revision);
  const committed = await commitCredentialRotation(storage, { attemptId, identity, to });
  assert.equal(committed.credentialGeneration, to);
  assert.equal(committed.credentialUpdate, null);
  assert.equal((await commitCredentialRotation(storage, { attemptId, identity, to })).revision, committed.revision);
  await assert.rejects(claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs }), /Stale/);
});

test("probe report waits for credential persistence and is idempotent", async () => {
  const nowMs = Date.parse("2026-11-04T04:00:00Z");
  const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  const storage = storageFake({ ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true }, credentialGeneration: from,
    quotaSnapshot: { source: "account/rateLimits/read", windowDurationMins: 300, observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000 } });
  await reservePreflight(storage, { attemptId, expectedRevision: 0, nowMs });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs });
  await prepareCredentialRotation(storage, { attemptId, identity, from, to });
  const snapshot = { source: "account/rateLimits/read", limitId: "codex", windowDurationMins: 300,
    observedAtMs: nowMs, resetAtMs: nowMs + 18000000, usedPercent: 1 };
  await assert.rejects(completePreflight(storage, { attemptId, identity, snapshot, nowMs }), /unconfirmed/);
  await authorizeCredentialWrite(storage, { attemptId, identity, to });
  await commitCredentialRotation(storage, { attemptId, identity, to });
  const done = await completePreflight(storage, { attemptId, identity, snapshot, nowMs });
  assert.equal(done.phase, "WAITING");
  assert.deepEqual(done.quotaSnapshot, snapshot);
  assert.equal((await completePreflight(storage, { attemptId, identity, snapshot: { ...snapshot }, nowMs })).revision, done.revision);
  assert.equal((await completePreflight(storage, { attemptId, identity, snapshot: { ...snapshot }, nowMs: nowMs + 20000000 })).revision, done.revision);
  await assert.rejects(completePreflight(storage, { attemptId, identity, snapshot: { ...snapshot, usedPercent: 2 }, nowMs }), /conflicts/);
});

test("credential bootstrap requires disabled idle state and binds an exact bundle digest", async () => {
  const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const digest = "a".repeat(64);
  const storage = storageFake();
  const prepared = await prepareCredentialBootstrap(storage, { generation, digest, expectedRevision: 0 });
  assert.deepEqual(prepared.credentialBootstrap, { generation, digest, writeState: "prepared" });
  assert.equal((await prepareCredentialBootstrap(storage, { generation, digest, expectedRevision: 0 })).revision, prepared.revision);
  await assert.rejects(prepareCredentialBootstrap(storage, { generation, digest: "b".repeat(64), expectedRevision: 1 }), /different/);
  await assert.rejects(commitCredentialBootstrap(storage, { generation, digest: "b".repeat(64) }), /does not match/);
  await assert.rejects(commitCredentialBootstrap(storage, { generation, digest }), /does not match/);
  await authorizeBootstrapWrite(storage, { generation, digest });
  await assert.rejects(authorizeBootstrapWrite(storage, { generation, digest }), /not authorized/);
  const committed = await commitCredentialBootstrap(storage, { generation, digest });
  assert.equal(committed.credentialGeneration, generation);
  assert.equal(committed.credentialBootstrap, null);
  assert.equal(committed.quotaSnapshot, null);
  assert.equal((await commitCredentialBootstrap(storage, { generation, digest })).revision, committed.revision);
  await assert.rejects(prepareCredentialBootstrap(storage, { generation, digest, expectedRevision: committed.revision }), /must change/);
  const enabled = storageFake({ ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true } });
  await assert.rejects(prepareCredentialBootstrap(enabled, { generation, digest, expectedRevision: 0 }), /disabled idle/);
});

test("an explicit manual probe can bootstrap quota while automatic activation is disabled", async () => {
  const nowMs = Date.parse("2026-11-04T16:00:00Z"); // 00:00 Hong Kong, during sleep.
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  const storage = storageFake({ ...initialState(), credentialGeneration });
  const reserved = await reserveManualProbe(storage, { attemptId, expectedRevision: 0, nowMs });
  assert.equal(reserved.attempt.kind, "manual_probe");
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  const claimed = await claimPreflight(storage, { attemptId, credentialGeneration, identity, nowMs });
  assert.equal(claimed.attempt.runId, "101");
  await assert.rejects(reserveManualProbe(storage, { attemptId, expectedRevision: claimed.revision, nowMs }), /busy/);
});
