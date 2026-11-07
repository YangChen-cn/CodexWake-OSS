import test from "node:test";
import assert from "node:assert/strict";
import { makeCredentialBundle } from "../src/credential-bundle.mjs";
import { credentialSmokeFromEnvironment } from "../scripts/credential-smoke.mjs";

test("credential smoke sends only generation and an unreserved attempt", async () => {
  const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } });
  const env = { CODEX_AUTH_BUNDLE: makeCredentialBundle(auth, generation), CODEXWAKE_WORKER_URL: "https://worker.example",
    CODEXWAKE_OIDC_AUDIENCE: "audience", ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/id", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic" };
  const result = await credentialSmokeFromEnvironment(env, { createOidc: () => async () => "a.b.c", fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.credentialGeneration, generation);
    assert.deepEqual(Object.keys(body).sort(), ["attemptId", "credentialGeneration"]);
    assert.equal(JSON.stringify(body).includes("synthetic-refresh"), false);
    return new Response(null, { status: 409 });
  } });
  assert.equal(result.outcome, "credential_schema_and_oidc_verified");
});
