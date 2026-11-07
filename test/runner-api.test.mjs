import test from "node:test";
import assert from "node:assert/strict";
import { handleRunnerRequest } from "../src/runner-api.mjs";

const oidc = { GITHUB_OIDC_AUDIENCE: "test", GITHUB_OIDC_REPOSITORY_ID: "123", GITHUB_OIDC_OWNER_ID: "456",
  GITHUB_OIDC_WORKFLOW_REF: "owner/repo/.github/workflows/wake.yml@refs/heads/main",
  GITHUB_OIDC_REF: "refs/heads/main", GITHUB_OIDC_WORKFLOW_SHA: "a".repeat(40) };
const body = { attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6", credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd" };
const request = (content = JSON.stringify(body), authorization = "Bearer a.b.c") => new Request("https://worker.example/v1/runner/claim", {
  method: "POST", headers: { authorization }, body: content,
});

test("runner claim requires configured and verified OIDC", async () => {
  assert.equal((await handleRunnerRequest(request(), {})).status, 503);
  assert.equal((await handleRunnerRequest(request(JSON.stringify(body), ""), oidc)).status, 401);
  assert.equal((await handleRunnerRequest(request(), oidc, { verify: async () => { throw new Error("bad token"); } })).status, 401);
  assert.equal((await handleRunnerRequest(request("x".repeat(4097)), oidc)).status, 400);
});

test("verified claim forwards only identity and generation to the coordinator", async () => {
  let calls = 0;
  const env = { ...oidc, COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), { ...body, identity: { runId: "101", runAttempt: "1", workflowSha: "a".repeat(40) } });
    return Response.json({ revision: 4 });
  } }) } };
  const response = await handleRunnerRequest(request(), env, { verify: async () => ({ runId: "101", runAttempt: "1", workflowSha: "a".repeat(40) }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revision: 4 });
  assert.equal(calls, 1);
});

test("credential rotation routes forward metadata only after OIDC verification", async () => {
  const forwarded = [];
  const env = { ...oidc, COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
    forwarded.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return Response.json({ revision: 5 });
  } }) } };
  const identity = { runId: "101", runAttempt: "1", workflowSha: "a".repeat(40) };
  const post = (path, value) => new Request(`https://worker.example${path}`, { method: "POST",
    headers: { authorization: "Bearer a.b.c" }, body: JSON.stringify(value) });
  const from = body.credentialGeneration;
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  assert.equal((await handleRunnerRequest(post("/v1/runner/credential/prepare", { attemptId: body.attemptId, from, to }), env,
    { verify: async () => identity })).status, 200);
  assert.equal((await handleRunnerRequest(post("/v1/runner/credential/commit", { attemptId: body.attemptId, to }), env,
    { verify: async () => identity })).status, 200);
  assert.deepEqual(forwarded.map((value) => value.path), ["/credential/prepare", "/credential/commit"]);
  assert.deepEqual(forwarded[0].body, { attemptId: body.attemptId, from, to, identity });
  assert.equal((await handleRunnerRequest(post("/v1/runner/credential/commit", { attemptId: body.attemptId, to, auth: "secret" }), env,
    { verify: async () => identity })).status, 400);
});

test("activation routes stay disabled unless explicitly configured and forward only allowed metadata", async () => {
  const identity = { runId: "101", runAttempt: "1", workflowSha: "a".repeat(40) };
  const forwarded = [];
  const env = { ...oidc, ACTIVATION_ENABLED: "true", COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => {
    forwarded.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return Response.json({ revision: 6, model: "current-model", message: "hello" });
  } }) } };
  const post = (value, authorization = "Bearer a.b.c") => new Request("https://worker.example/v1/runner/activation/authorize", {
    method: "POST", headers: { authorization }, body: JSON.stringify(value) });
  const payload = { attemptId: body.attemptId, cliVersion: "0.166.0", models: [{ id: "current-model" }] };
  assert.equal((await handleRunnerRequest(post(payload), { ...env, ACTIVATION_ENABLED: undefined })).status, 503);
  assert.equal((await handleRunnerRequest(post(payload, ""), env)).status, 401);
  assert.equal((await handleRunnerRequest(post({ ...payload, models: [{ id: "current-model", auth: "secret" }] }), env)).status, 400);
  const response = await handleRunnerRequest(post(payload), env, { verify: async () => identity });
  assert.deepEqual(await response.json(), { ok: true, revision: 6, model: "current-model", message: "hello" });
  assert.deepEqual(forwarded, [{ path: "/activation/authorize", body: { ...payload, identity } }]);
});
