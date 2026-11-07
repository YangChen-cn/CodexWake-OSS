import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubOidcProvider, createRunnerCoordinator } from "../src/runner-coordinator.mjs";

test("OIDC provider uses the GitHub job URL and sets audience without leaking credentials", async () => {
  const getToken = createGitHubOidcProvider({ requestUrl: "https://pipelines.actions.githubusercontent.com/job?existing=1",
    requestToken: "synthetic-bootstrap", audience: "codexwake" }, { fetch: async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("existing"), "1");
    assert.equal(parsed.searchParams.get("audience"), "codexwake");
    assert.equal(init.headers.Authorization, "Bearer synthetic-bootstrap");
    assert.equal(init.redirect, "error");
    return Response.json({ value: "header.payload.signature" });
  } });
  assert.equal(await getToken(), "header.payload.signature");
});

test("rejects untrusted OIDC endpoints, malformed tokens and redirects", async () => {
  for (const requestUrl of ["http://pipelines.actions.githubusercontent.com/job", "https://actions.githubusercontent.com.evil.test/job",
    "https://user:pass@pipelines.actions.githubusercontent.com/job"]) {
    assert.throws(() => createGitHubOidcProvider({ requestUrl, requestToken: "test", audience: "test" }));
  }
  const getToken = createGitHubOidcProvider({ requestUrl: "https://pipelines.actions.githubusercontent.com/job",
    requestToken: "test", audience: "test" }, { fetch: async () => Response.json({ value: "not-a-jwt" }) });
  await assert.rejects(getToken(), /unavailable/);
});

test("coordinator calls use a fresh OIDC token and forward only metadata", async () => {
  const calls = [];
  let tokens = 0;
  const client = createRunnerCoordinator({ baseUrl: "https://worker.example", getOidcToken: async () => { tokens++; return "a.b.c"; } },
    { fetch: async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return Response.json({ ok: true, revision: calls.length }); } });
  await client.claim({ attemptId: "attempt", credentialGeneration: "generation", unwanted: "secret" });
  await client.prepare({ attemptId: "attempt", from: "old", to: "new" });
  await client.commit({ attemptId: "attempt", to: "new" });
  assert.equal(tokens, 3);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/runner/claim", "/v1/runner/credential/prepare", "/v1/runner/credential/commit"]);
  assert.deepEqual(calls[0].body, { attemptId: "attempt", credentialGeneration: "generation" });
  assert.equal(calls[0].headers.Authorization, "Bearer a.b.c");
});

test("unconfirmed coordinator responses fail closed without response contents", async () => {
  assert.throws(() => createRunnerCoordinator({ baseUrl: "http://worker.example", getOidcToken: async () => "a.b.c" }));
  const client = createRunnerCoordinator({ baseUrl: "https://worker.example", getOidcToken: async () => "a.b.c" },
    { fetch: async () => new Response("sensitive response", { status: 409 }) });
  await assert.rejects(client.commit({ attemptId: "a", to: "b" }), (error) => error.message === "Coordinator request unconfirmed");
});

test("activation permission is returned only after a validated single coordinator request", async () => {
  let calls = 0;
  const client = createRunnerCoordinator({ baseUrl: "https://worker.example", getOidcToken: async () => "a.b.c" }, {
    fetch: async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(init.body), { attemptId: "attempt", models: [{ id: "current-model" }], cliVersion: "0.166.0" });
      return Response.json({ ok: true, revision: 7, model: "current-model", message: "hello" });
    },
  });
  assert.deepEqual(await client.authorizeActivation({ attemptId: "attempt", models: [{ id: "current-model" }], cliVersion: "0.166.0" }),
    { revision: 7, model: "current-model", message: "hello" });
  assert.equal(calls, 1);
});
