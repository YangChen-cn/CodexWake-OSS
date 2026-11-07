import test from "node:test";
import assert from "node:assert/strict";
import { makeCredentialBundle, parseCredentialBundle } from "../src/credential-bundle.mjs";
import { persistRefreshedCredential } from "../src/persist-credential.mjs";

const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const auth = { auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } };
const originalBundle = makeCredentialBundle(JSON.stringify(auth), from);
const updatedAuth = JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "synthetic-new" } });

test("updated credential is reserved, encrypted, written and committed in order", async () => {
  const calls = [];
  const coordinator = { prepare: async (value) => calls.push(["prepare", value]), authorizeWrite: async (value) => calls.push(["authorize", value]), commit: async (value) => calls.push(["commit", value]) };
  const result = await persistRefreshedCredential({ originalBundle, updatedAuth, nextGeneration: to, attemptId, githubConfig: {}, coordinator }, {
    prepareSecretWrite: async (_config, bundle) => { calls.push(["encrypt"]); assert.equal(parseCredentialBundle(bundle).generation, to); return { encrypted: true }; },
    writeSecret: async () => { calls.push(["write"]); return { outcome: "confirmed" }; },
  });
  assert.deepEqual(calls.map(([name]) => name), ["prepare", "encrypt", "authorize", "write", "commit"]);
  assert.deepEqual(calls[0][1], { attemptId, from, to });
  assert.deepEqual(result, { outcome: "updated", generation: to });
});

test("unchanged credentials do not update GitHub", async () => {
  const result = await persistRefreshedCredential({ originalBundle, updatedAuth: JSON.stringify(auth), nextGeneration: to,
    attemptId, githubConfig: {}, coordinator: {} });
  assert.deepEqual(result, { outcome: "unchanged", generation: from });
});

test("ambiguous writes never commit or rerun the model", async () => {
  let commits = 0;
  const coordinator = { prepare: async () => {}, authorizeWrite: async () => {}, commit: async () => { commits++; } };
  const result = await persistRefreshedCredential({ originalBundle, updatedAuth, nextGeneration: to, attemptId, githubConfig: {}, coordinator }, {
    prepareSecretWrite: async () => ({ encrypted: true }), writeSecret: async () => ({ outcome: "unknown" }),
  });
  assert.deepEqual(result, { outcome: "pending", reason: "write_unconfirmed" });
  assert.equal(commits, 0);
});

test("a lost commit response is reported as pending without disclosing the bundle", async () => {
  const coordinator = { prepare: async () => {}, authorizeWrite: async () => {}, commit: async () => { throw new Error("synthetic network failure"); } };
  const result = await persistRefreshedCredential({ originalBundle, updatedAuth, nextGeneration: to, attemptId, githubConfig: {}, coordinator }, {
    prepareSecretWrite: async () => ({ encrypted: true }), writeSecret: async () => ({ outcome: "confirmed" }), retryOptions: { delayMs: 0 },
  });
  assert.deepEqual(result, { outcome: "pending", reason: "commit_unconfirmed" });
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
});

test("write authorization is never retried after an uncertain response", async () => {
  let authorizations = 0;
  let writes = 0;
  const coordinator = { prepare: async () => {}, authorizeWrite: async () => { authorizations++; throw new Error("lost"); } };
  const result = await persistRefreshedCredential({ originalBundle, updatedAuth, nextGeneration: to, attemptId, githubConfig: {}, coordinator }, {
    prepareSecretWrite: async () => ({ encrypted: true }), writeSecret: async () => { writes++; return { outcome: "confirmed" }; },
    retryOptions: { delayMs: 0 },
  });
  assert.equal(result.reason, "write_authorization_unconfirmed");
  assert.equal(authorizations, 1);
  assert.equal(writes, 0);
});
