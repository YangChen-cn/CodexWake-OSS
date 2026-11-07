import test from "node:test";
import assert from "node:assert/strict";
import { Coordinator } from "../src/coordinator.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { initialState, readState } from "../src/state.mjs";
import { initialConservativeWindow } from "../src/conservative-window.mjs";

function storageFake(initial) {
  let value = initial;
  let tail = Promise.resolve();
  return { get: async () => structuredClone(value), transaction(callback) {
    const work = tail.then(async () => { let pending = structuredClone(value);
      const result = await callback({ get: async () => structuredClone(pending), put: async (_key, next) => { pending = structuredClone(next); } });
      value = pending; return result; });
    tail = work.catch(() => {}); return work;
  } };
}
const env = { ACTIVATION_ENABLED: "true", GITHUB_DISPATCH_OWNER: "owner", GITHUB_DISPATCH_REPO: "repo",
  GITHUB_OIDC_REF: "refs/heads/main", GITHUB_ACTIONS_WRITE_TOKEN: "synthetic-actions-token",
  GITHUB_OIDC_WORKFLOW_REF: "owner/repo/.github/workflows/wake.yml@refs/heads/main", GITHUB_OIDC_REPOSITORY_ID: "123",
  GITHUB_OIDC_OWNER_ID: "456", GITHUB_OIDC_WORKFLOW_SHA: "a".repeat(40), GITHUB_OIDC_AUDIENCE: "codexwake" };
const minutes = (n) => `${String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((n % 1440) + 1440) % 60).padStart(2, "0")}`;
const put = (config, expectedRevision) => new Request("https://internal/config", { method: "PUT", body: JSON.stringify({ config, expectedRevision }) });
const tick = () => new Request("https://internal/tick", { method: "POST" });
const manual = (expectedRevision) => new Request("https://internal/manual-wake", { method: "POST", body: JSON.stringify({ expectedRevision }) });

test("automatic activation cannot be enabled or dispatched using only an estimated timer", async () => {
  const nowMs = Date.now();
  const current = new Date(nowMs).getUTCHours() * 60 + new Date(nowMs).getUTCMinutes();
  const config = { ...DEFAULT_CONFIG, model: "current-model", timeZone: "UTC", allowedStart: minutes(current - 30),
    allowedEnd: minutes(current + 90), sleepStart: minutes(current + 180), sleepEnd: minutes(current + 240) };
  const state = { ...initialState(), config, credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd", conservativeAcknowledged: true,
    conservativeEstimate: initialConservativeWindow({ acknowledged: true, nowMs: nowMs - 6 * 3600000 }),
    modelAttestation: { source: "local_model_list", model: config.model, cliVersion: "0.166.0", verifiedAtMs: nowMs - 1000, expiresAtMs: nowMs + 86400000 } };
  const storage = storageFake(state);
  let calls = 0;
  const dispatch = async ({ workflow }) => { assert.equal(workflow, "wake.yml"); calls++; return { outcome: "accepted", runId: "101" }; };
  const coordinator = new Coordinator({ storage }, env, { dispatch });
  assert.equal((await coordinator.fetch(put({ ...config, autoEnabled: true }, 0))).status, 409);
  assert.equal((await (await coordinator.fetch(manual(0))).json()).reason, "activity_wakes_not_enabled");
  assert.equal((await (await coordinator.fetch(new Request("https://internal/status"))).json()).automaticBlockReason, "activity_wakes_not_enabled");
  const legacy = storageFake({ ...state, config: { ...config, autoEnabled: true } });
  const legacyCoordinator = new Coordinator({ storage: legacy }, env, { dispatch });
  const tickResult = await (await legacyCoordinator.fetch(tick())).json();
  assert.equal(tickResult.result.reason, "activity_wakes_not_enabled");
  assert.equal((await (await legacyCoordinator.fetch(manual(0))).json()).reason, "activity_wakes_not_enabled");
  assert.equal(calls, 0);
  assert.equal((await legacyCoordinator.fetch(put({ ...config, autoEnabled: false }, 0))).status, 200);
  assert.equal((await readState(legacy)).config.autoEnabled, false);
});

test("a legacy automatic attempt cannot obtain a model-turn permit", async () => {
  const nowMs = Date.now();
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const storage = storageFake({ ...initialState(), phase: "DISPATCHING", credentialGeneration,
    config: { ...DEFAULT_CONFIG, autoEnabled: true, model: "current-model" },
    attempt: { id: attemptId, kind: "estimated_activation", reservedAtMs: nowMs, configGeneration: 0,
      credentialGeneration, runId: "101", runAttempt: "1", dispatch: { outcome: "accepted", runId: "101" } } });
  const coordinator = new Coordinator({ storage }, env);
  const response = await coordinator.fetch(new Request("https://internal/activation/authorize", { method: "POST", body: JSON.stringify({
    attemptId, identity: { runId: "101", runAttempt: "1" }, cliVersion: "0.166.0", models: [{ id: "current-model" }],
  }) }));
  assert.equal(response.status, 409);
  assert.equal((await readState(storage)).phase, "DISPATCHING");
});

test("recovery verifies the real run before clearing the credential generation", async () => {
  const nowMs = Date.now();
  const state = { ...initialState(), phase: "FAILED", credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd",
    attempt: { id: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6", kind: "estimated_activation", reservedAtMs: nowMs - 5000,
      permitIssuedAtMs: nowMs - 1000, configGeneration: 0, credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd",
      runId: "101", runAttempt: "1", dispatch: { outcome: "accepted", runId: "101" } } };
  const storage = storageFake(state);
  const req = () => new Request("https://internal/recover", { method: "POST", body: JSON.stringify({ confirmed: true, expectedRevision: 0 }) });
  const blocked = new Coordinator({ storage }, env, { verifyRun: async () => false });
  assert.equal((await blocked.fetch(req())).status, 409);
  assert.notEqual((await readState(storage)).credentialGeneration, null);
  const coordinator = new Coordinator({ storage }, env, { verifyRun: async ({ runId, repositoryId, workflowSha }) => {
    assert.equal(runId, "101"); assert.equal(repositoryId, "123"); assert.equal(workflowSha, "a".repeat(40)); return true;
  } });
  const response = await coordinator.fetch(req());
  assert.deepEqual(await response.json(), { revision: 1, reauthenticationRequired: true });
  assert.equal((await readState(storage)).credentialGeneration, null);
});

test("explicit manual test bypasses the schedule only while automatic mode is disabled", async () => {
  const nowMs = Date.now();
  const state = { ...initialState(), credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd",
    config: { ...DEFAULT_CONFIG, model: "current-model" }, modelAttestation: { source: "local_model_list", model: "current-model",
      cliVersion: "0.166.0", verifiedAtMs: nowMs - 90 * 86400000, expiresAtMs: nowMs - 60 * 86400000 } };
  const storage = storageFake(state);
  let calls = 0;
  const coordinator = new Coordinator({ storage }, env, { dispatch: async () => { calls++; return { outcome: "accepted", runId: "101" }; } });
  const status = await (await coordinator.fetch(new Request("https://internal/status"))).json();
  assert.equal(Object.hasOwn(status.modelAttestation, "expiresAtMs"), false);
  const request = (expectedRevision) => new Request("https://internal/manual-test", { method: "POST", body: JSON.stringify({ expectedRevision }) });
  const result = await (await coordinator.fetch(request(0))).json();
  assert.equal(result.outcome, "accepted");
  assert.equal((await readState(storage)).config.autoEnabled, false);
  assert.equal((await coordinator.fetch(request(result.revision))).status, 409);
  assert.equal(calls, 1);
});
