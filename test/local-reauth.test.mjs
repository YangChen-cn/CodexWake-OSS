import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { registerLocalAccount } from "../src/local-reauth.mjs";

const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const base = { phase: "WAITING", config: { ...DEFAULT_CONFIG, model: "current-model" }, credentialUpdatePending: false, credentialBootstrap: null, revision: 1 };

test("registration bootstraps, attests, enrolls and resumes in order", async () => {
  let state = { ...base };
  const calls = [];
  const admin = { status: async () => structuredClone(state), setConfig: async ({ config, expectedRevision }) => {
    assert.equal(expectedRevision, state.revision); calls.push("config"); state = { ...state, config, revision: state.revision + 1 };
  }, attestModels: async ({ expectedRevision, models }) => {
    assert.equal(expectedRevision, state.revision); assert.deepEqual(models, [{ id: "current-model" }]); calls.push("attest"); state.revision++;
  }, enrollConservative: async ({ expectedRevision }) => { assert.equal(expectedRevision, state.revision); calls.push("enroll");
    state.revision++; state.conservativeEstimate = { notBeforeMs: 42 }; } };
  const result = await registerLocalAccount({ admin, authText: "synthetic-auth", models: [{ id: "current-model", isDefault: true }],
    cliVersion: "0.166.0", githubConfig: {}, resume: true }, { newGeneration: () => generation, bootstrap: async ({ expectedRevision }) => {
    assert.equal(expectedRevision, state.revision); calls.push("bootstrap"); state = { ...state, credentialGeneration: generation, revision: state.revision + 1 }; return { outcome: "updated" };
  } });
  assert.deepEqual(calls, ["bootstrap", "attest", "enroll", "config"]);
  assert.deepEqual(result, { outcome: "updated", enabled: true, model: "current-model", notBeforeMs: 42 });
});

test("registration never proceeds after an ambiguous credential write", async () => {
  let attest = false;
  const admin = { status: async () => structuredClone(base), attestModels: async () => { attest = true; } };
  const result = await registerLocalAccount({ admin, authText: "synthetic", models: [{ id: "current-model" }], cliVersion: "0.166.0", githubConfig: {} },
    { newGeneration: () => generation, bootstrap: async () => ({ outcome: "pending" }) });
  assert.equal(result.reason, "credential_bootstrap_unconfirmed");
  assert.equal(attest, false);
});
