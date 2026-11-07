import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { FIVE_HOURS_MS, DEFAULT_MARGIN_MS } from "../src/conservative-window.mjs";
import { initialState, readState, replaceConfig, enrollConservativeMode, reserveEstimatedActivation,
  recordDispatchOutcome, claimPreflight, authorizeEstimatedActivation, completeEstimatedActivation, completePreflight,
  prepareCredentialRotation, authorizeCredentialWrite, commitCredentialRotation, attestLocalModelCatalog, reserveSuccessNotification, resetAfterCompletedRun, reserveManualTest, releaseRejectedManualTest } from "../src/state.mjs";

const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const identity = { runId: "101", runAttempt: "1" };
const start = Date.parse("2026-11-05T00:00:00Z");
const due = start + FIVE_HOURS_MS + DEFAULT_MARGIN_MS;
const selectedModel = "current-test-model";

function storageFake(initial) {
  let value = initial;
  let tail = Promise.resolve();
  return {
    async get() { return structuredClone(value); },
    transaction(callback) {
      const work = tail.then(async () => {
        let pending = structuredClone(value);
        const result = await callback({ get: async () => structuredClone(pending), put: async (_key, next) => { pending = structuredClone(next); } });
        value = pending;
        return result;
      });
      tail = work.catch(() => {});
      return work;
    },
  };
}

async function claimed() {
  const storage = storageFake({ ...initialState(), credentialGeneration: from });
  await enrollConservativeMode(storage, { acknowledged: true, expectedRevision: 0, nowMs: start });
  await replaceConfig(storage, { ...DEFAULT_CONFIG, autoEnabled: true, model: selectedModel }, 1);
  await reserveEstimatedActivation(storage, { attemptId, expectedRevision: 2, nowMs: due });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: identity.runId });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs: due });
  return storage;
}

test("estimated activation has one permit and saves refreshed credentials before completion", async () => {
  const storage = await claimed();
  await assert.rejects(authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: "other" }], nowMs: due }), /not currently available/);
  const permit = await authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due });
  assert.equal(permit.state.phase, "ACTIVATING");
  assert.equal(permit.model, selectedModel);
  await assert.rejects(authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due }), /not authorized/);
  const snapshot = { source: "account/rateLimits/read", limitId: "codex", windowDurationMins: 300,
    observedAtMs: due, resetAtMs: due + FIVE_HOURS_MS, usedPercent: 0 };
  await assert.rejects(completePreflight(storage, { attemptId, identity, snapshot, nowMs: due }), /cannot report/);
  await prepareCredentialRotation(storage, { attemptId, identity, from, to });
  await assert.rejects(completeEstimatedActivation(storage, { attemptId, identity, outcome: "completed_unverified",
    startedAtMs: due, finishedAtMs: due + 1000, nowMs: due + 2000 }), /credential status/);
  await authorizeCredentialWrite(storage, { attemptId, identity, to });
  await commitCredentialRotation(storage, { attemptId, identity, to });
  const done = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "completed_unverified",
    startedAtMs: due, finishedAtMs: due + 1000, nowMs: due + 2000 });
  assert.equal(done.phase, "WAITING");
  assert.equal(done.lastActivation.outcome, "completed_unverified");
  assert.equal(done.conservativeEstimate.notBeforeMs, due + 2000 + FIVE_HOURS_MS + DEFAULT_MARGIN_MS);
  const repeated = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "completed_unverified",
    startedAtMs: due, finishedAtMs: due + 1000, nowMs: due + 5000 });
  assert.equal(repeated.revision, done.revision);
});

test("an unconfirmed activation remains failed and blocks another reservation", async () => {
  const storage = await claimed();
  await authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due });
  const failed = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "unconfirmed",
    startedAtMs: due, finishedAtMs: due + 1000, nowMs: due + 2000 });
  assert.equal(failed.phase, "FAILED");
  await assert.rejects(reserveEstimatedActivation(storage, { attemptId: to, expectedRevision: failed.revision,
    nowMs: due + FIVE_HOURS_MS }), /busy/);
  assert.equal((await readState(storage)).lastActivation.outcome, "unconfirmed");
});

test("disabling after claim prevents the one-shot permit", async () => {
  const storage = await claimed();
  const state = await readState(storage);
  await replaceConfig(storage, { ...state.config, autoEnabled: false }, state.revision);
  await assert.rejects(authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due }), /not authorized/);
});

test("concurrent reservations have a single winner", async () => {
  const storage = storageFake({ ...initialState(), credentialGeneration: from });
  await enrollConservativeMode(storage, { acknowledged: true, expectedRevision: 0, nowMs: start });
  await replaceConfig(storage, { ...DEFAULT_CONFIG, autoEnabled: true, model: selectedModel }, 1);
  const attempts = await Promise.allSettled([
    reserveEstimatedActivation(storage, { attemptId, expectedRevision: 2, nowMs: due }),
    reserveEstimatedActivation(storage, { attemptId: to, expectedRevision: 2, nowMs: due }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
});

test("fallback model attestation must match the selected model and CLI version", async () => {
  const storage = storageFake({ ...initialState(), credentialGeneration: from, config: { ...DEFAULT_CONFIG, model: selectedModel } });
  await assert.rejects(attestLocalModelCatalog(storage, { models: [{ id: "other" }], cliVersion: "0.166.0", expectedRevision: 0, nowMs: start }), /not in catalog/);
  const attested = await attestLocalModelCatalog(storage, { models: [{ id: selectedModel }], cliVersion: "0.166.0", expectedRevision: 0, nowMs: start });
  assert.equal(attested.modelAttestation.source, "local_model_list");
  await enrollConservativeMode(storage, { acknowledged: true, expectedRevision: 1, nowMs: start });
  await replaceConfig(storage, { ...DEFAULT_CONFIG, autoEnabled: true, model: selectedModel }, 2);
  await reserveEstimatedActivation(storage, { attemptId, expectedRevision: 3, nowMs: due });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs: due });
  await assert.rejects(authorizeEstimatedActivation(storage, { attemptId, identity, models: [], cliVersion: "0.165.0", nowMs: due }), /not currently available/);
  const permit = await authorizeEstimatedActivation(storage, { attemptId, identity, models: [], cliVersion: "0.166.0", nowMs: due });
  assert.equal(permit.model, selectedModel);
});

test("manual test runs exactly once while automatic activation remains disabled", async () => {
  const storage = storageFake({ ...initialState(), credentialGeneration: from, config: { ...DEFAULT_CONFIG, model: selectedModel },
    modelAttestation: { source: "local_model_list", model: selectedModel, cliVersion: "0.166.0", verifiedAtMs: start - 365 * 86400000, expiresAtMs: start - 1 } });
  await reserveManualTest(storage, { attemptId, expectedRevision: 0, nowMs: start });
  await assert.rejects(reserveManualTest(storage, { attemptId: to, expectedRevision: 1, nowMs: start }), /disabled idle/);
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs: start });
  const permit = await authorizeEstimatedActivation(storage, { attemptId, identity, models: [], cliVersion: "0.166.0", nowMs: start });
  assert.equal(permit.model, selectedModel);
  await assert.rejects(authorizeEstimatedActivation(storage, { attemptId, identity, models: [], cliVersion: "0.166.0", nowMs: start }), /not authorized/);
  const done = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "completed_unverified",
    startedAtMs: start, finishedAtMs: start + 1000, nowMs: start + 2000 });
  assert.equal(done.phase, "WAITING");
  assert.equal(done.config.autoEnabled, false);
  assert.equal(done.conservativeEstimate.notBeforeMs, start + 2000 + FIVE_HOURS_MS + DEFAULT_MARGIN_MS);
});

test("only a definitively rejected unclaimed manual test can be released", async () => {
  const make = () => storageFake({ ...initialState(), credentialGeneration: from, config: { ...DEFAULT_CONFIG, model: selectedModel } });
  const unknown = make();
  await reserveManualTest(unknown, { attemptId, expectedRevision: 0, nowMs: start });
  await recordDispatchOutcome(unknown, { attemptId, outcome: "unknown", httpStatus: 500 });
  await assert.rejects(releaseRejectedManualTest(unknown, { attemptId, expectedRevision: 2 }), /unsafe/);
  const rejected = make();
  await reserveManualTest(rejected, { attemptId, expectedRevision: 0, nowMs: start });
  await recordDispatchOutcome(rejected, { attemptId, outcome: "rejected", httpStatus: 403 });
  await assert.rejects(releaseRejectedManualTest(rejected, { attemptId, expectedRevision: 1 }), /unsafe/);
  await assert.rejects(releaseRejectedManualTest(rejected, { attemptId: to, expectedRevision: 2 }), /unsafe/);
  const released = await releaseRejectedManualTest(rejected, { attemptId, expectedRevision: 2 });
  assert.equal(released.phase, "WAITING");
  assert.equal(released.config.autoEnabled, false);
  assert.equal(released.credentialGeneration, from);
  assert.equal(released.attempt, null);
});

test("a failed manual test never schedules an automatic retry", async () => {
  const storage = storageFake({ ...initialState(), credentialGeneration: from, config: { ...DEFAULT_CONFIG, model: selectedModel } });
  await reserveManualTest(storage, { attemptId, expectedRevision: 0, nowMs: start });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });
  await claimPreflight(storage, { attemptId, credentialGeneration: from, identity, nowMs: start });
  await authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: start });
  const failed = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "not_started",
    startedAtMs: start, finishedAtMs: start, nowMs: start });
  assert.equal(failed.phase, "FAILED");
  assert.equal(failed.config.autoEnabled, false);
  assert.equal(failed.estimatedRetry, undefined);
});

test("successful run reserves at most one notification attempt", async () => {
  // Emulate a completed run and exercise the transactional outbox.
  const finished = storageFake({ ...initialState(), config: { ...DEFAULT_CONFIG, notifySuccess: true },
    lastActivation: { attemptId, outcome: "completed_unverified" } });
  const reservations = await Promise.all([reserveSuccessNotification(finished, { attemptId }), reserveSuccessNotification(finished, { attemptId })]);
  assert.equal(reservations.filter((result) => result.reserved).length, 1);
  assert.equal((await readState(finished)).lastNotificationAttempt, attemptId);
});

test("verified recovery pauses the service and requires a fresh credential bootstrap", async () => {
  const storage = await claimed();
  await authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due });
  const failed = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "unconfirmed",
    startedAtMs: due, finishedAtMs: due + 1000, nowMs: due + 2000 });
  await assert.rejects(resetAfterCompletedRun(storage, { expectedRevision: failed.revision, attemptId, runId: "102", nowMs: due + 3000 }), /unsafe/);
  const reset = await resetAfterCompletedRun(storage, { expectedRevision: failed.revision, attemptId, runId: "101", nowMs: due + 3000 });
  assert.equal(reset.phase, "WAITING");
  assert.equal(reset.config.autoEnabled, false);
  assert.equal(reset.credentialGeneration, null);
  assert.equal(reset.conservativeAcknowledged, false);
  assert.equal(reset.lastRecovery.reauthenticationRequired, true);
});

test("only a definitively unstarted process gets bounded delayed retries", async () => {
  const storage = await claimed();
  await authorizeEstimatedActivation(storage, { attemptId, identity, models: [{ id: selectedModel }], nowMs: due });
  let state = await completeEstimatedActivation(storage, { attemptId, identity, outcome: "not_started",
    startedAtMs: due, finishedAtMs: due, nowMs: due });
  assert.equal(state.phase, "WAITING");
  assert.equal(state.estimatedRetry.count, 1);
  const nextAttempt = "51c854e8-23cc-4d57-8e1a-3078a9fd28d7";
  await assert.rejects(reserveEstimatedActivation(storage, { attemptId: nextAttempt, expectedRevision: state.revision, nowMs: due + 1000 }), /Retry interval/);
  const retryTime = state.estimatedRetry.notBeforeMs;
  await reserveEstimatedActivation(storage, { attemptId: nextAttempt, expectedRevision: state.revision, nowMs: retryTime });
  await recordDispatchOutcome(storage, { attemptId: nextAttempt, outcome: "accepted", runId: "102" });
  const nextIdentity = { runId: "102", runAttempt: "1" };
  await claimPreflight(storage, { attemptId: nextAttempt, credentialGeneration: from, identity: nextIdentity, nowMs: retryTime });
  await authorizeEstimatedActivation(storage, { attemptId: nextAttempt, identity: nextIdentity, models: [{ id: selectedModel }], nowMs: retryTime });
  state = await completeEstimatedActivation(storage, { attemptId: nextAttempt, identity: nextIdentity, outcome: "not_started",
    startedAtMs: retryTime, finishedAtMs: retryTime, nowMs: retryTime });
  assert.equal(state.estimatedRetry.count, 2);
  const finalAttempt = "8cbd0a29-0c31-438d-9c02-dc9ec555b44e";
  const finalTime = state.estimatedRetry.notBeforeMs;
  await reserveEstimatedActivation(storage, { attemptId: finalAttempt, expectedRevision: state.revision, nowMs: finalTime });
  await recordDispatchOutcome(storage, { attemptId: finalAttempt, outcome: "accepted", runId: "103" });
  const finalIdentity = { runId: "103", runAttempt: "1" };
  await claimPreflight(storage, { attemptId: finalAttempt, credentialGeneration: from, identity: finalIdentity, nowMs: finalTime });
  await authorizeEstimatedActivation(storage, { attemptId: finalAttempt, identity: finalIdentity, models: [{ id: selectedModel }], nowMs: finalTime });
  state = await completeEstimatedActivation(storage, { attemptId: finalAttempt, identity: finalIdentity, outcome: "not_started",
    startedAtMs: finalTime, finishedAtMs: finalTime, nowMs: finalTime });
  assert.equal(state.phase, "FAILED");
});
