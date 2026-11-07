import test from "node:test";
import assert from "node:assert/strict";
import { smokeFromEnvironment } from "../scripts/oidc-smoke.mjs";

const env = { CODEXWAKE_WORKER_URL: "https://worker.example", CODEXWAKE_OIDC_AUDIENCE: "audience",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/id", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic" };

test("OIDC smoke requires a coordinator rejection and never sends OAuth", async () => {
  const result = await smokeFromEnvironment(env, { createOidc: () => async () => "a.b.c", fetch: async (url, init) => {
    assert.equal(new URL(url).pathname, "/v1/runner/claim");
    assert.equal(init.headers.Authorization, "Bearer a.b.c");
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["attemptId", "credentialGeneration"]);
    return new Response(null, { status: 409 });
  } });
  assert.deepEqual(result, { outcome: "oidc_verified" });
  await assert.rejects(smokeFromEnvironment(env, { createOidc: () => async () => "a.b.c", fetch: async () => new Response(null, { status: 401 }) }));
});
