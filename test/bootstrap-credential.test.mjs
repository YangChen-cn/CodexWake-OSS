import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapCredential } from "../src/bootstrap-credential.mjs";
import { parseCredentialBundle } from "../src/credential-bundle.mjs";

const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const authText = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } });

test("bootstrap reserves bundle digest before writing, then commits", async () => {
  const calls = [];
  const admin = { prepareBootstrap: async (input) => calls.push(["prepare", input]), authorizeBootstrapWrite: async (input) => calls.push(["authorize", input]), commitBootstrap: async (input) => calls.push(["commit", input]) };
  const result = await bootstrapCredential({ authText, generation, expectedRevision: 0, admin, githubConfig: {} }, {
    prepareSecretWrite: async (_config, bundle) => { calls.push(["encrypt"]); assert.equal(parseCredentialBundle(bundle).generation, generation); return { encrypted: true }; },
    writeSecret: async () => { calls.push(["write"]); return { outcome: "confirmed" }; },
  });
  assert.deepEqual(calls.map(([name]) => name), ["prepare", "encrypt", "authorize", "write", "commit"]);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(calls[0][1].digest, result.digest);
  assert.deepEqual(calls[4][1], { generation, digest: result.digest });
  assert.equal(result.outcome, "updated");
  assert.equal(JSON.stringify(result).includes("synthetic-refresh"), false);
});

test("ambiguous GitHub response leaves bootstrap pending without commit", async () => {
  let commits = 0;
  const admin = { prepareBootstrap: async () => {}, authorizeBootstrapWrite: async () => {}, commitBootstrap: async () => { commits++; } };
  const result = await bootstrapCredential({ authText, generation, expectedRevision: 0, admin, githubConfig: {} }, {
    prepareSecretWrite: async () => ({ encrypted: true }), writeSecret: async () => ({ outcome: "unknown" }),
  });
  assert.equal(result.outcome, "pending");
  assert.equal(result.reason, "write_unconfirmed");
  assert.equal(commits, 0);
});

test("unconfirmed reservation never writes to GitHub", async () => {
  let writes = 0;
  const result = await bootstrapCredential({ authText, generation, expectedRevision: 0,
    admin: { prepareBootstrap: async () => { throw new Error("synthetic failure"); } }, githubConfig: {} }, {
    prepareSecretWrite: async () => { writes++; return {}; }, retryOptions: { delayMs: 0 },
  });
  assert.equal(result.reason, "reservation_unconfirmed");
  assert.equal(writes, 0);
});

test("bootstrap write authorization is never retried", async () => {
  let authorizations = 0;
  let writes = 0;
  const admin = { prepareBootstrap: async () => {}, authorizeBootstrapWrite: async () => { authorizations++; throw new Error("lost"); } };
  const result = await bootstrapCredential({ authText, generation, expectedRevision: 0, admin, githubConfig: {} }, {
    prepareSecretWrite: async () => ({ encrypted: true }), writeSecret: async () => { writes++; return { outcome: "confirmed" }; },
    retryOptions: { delayMs: 0 },
  });
  assert.equal(result.reason, "write_authorization_unconfirmed");
  assert.equal(authorizations, 1);
  assert.equal(writes, 0);
});
