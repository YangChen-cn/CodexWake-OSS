import test from "node:test";
import assert from "node:assert/strict";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

const adminToken = "a".repeat(43);
test("admin client forwards only bootstrap metadata over HTTPS", async () => {
  const calls = [];
  const client = createAdminCoordinator({ baseUrl: "https://worker.example", adminToken }, { fetch: async (url, init) => {
    calls.push({ url, init }); return Response.json({ revision: calls.length });
  } });
  await client.status();
  await client.prepareBootstrap({ generation: "gen", digest: "digest", expectedRevision: 0, auth: "secret" });
  await client.commitBootstrap({ generation: "gen", digest: "digest" });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/admin/status", "/v1/admin/bootstrap/prepare", "/v1/admin/bootstrap/commit"]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { generation: "gen", digest: "digest", expectedRevision: 0 });
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${adminToken}`);
  assert.equal(calls[1].init.redirect, "error");
});

test("configuration updates use validated config and optimistic revision", async () => {
  let call;
  const client = createAdminCoordinator({ baseUrl: "https://worker.example", adminToken }, { fetch: async (url, init) => {
    call = { url, init }; return Response.json({ revision: 4 });
  } });
  await client.setConfig({ config: DEFAULT_CONFIG, expectedRevision: 3 });
  assert.equal(new URL(call.url).pathname, "/v1/admin/config");
  assert.equal(call.init.method, "PUT");
  assert.equal(JSON.parse(call.init.body).expectedRevision, 3);
  assert.throws(() => client.setConfig({ config: { ...DEFAULT_CONFIG, timeZone: "not-a-zone" }, expectedRevision: 3 }));
});

test("admin client rejects insecure destinations and does not expose failed response bodies", async () => {
  assert.throws(() => createAdminCoordinator({ baseUrl: "http://worker.example", adminToken }));
  assert.throws(() => createAdminCoordinator({ baseUrl: "https://user:pass@worker.example", adminToken }));
  const client = createAdminCoordinator({ baseUrl: "https://worker.example", adminToken },
    { fetch: async () => new Response("synthetic sensitive data", { status: 403 }) });
  await assert.rejects(client.status(), (error) => error.message === "Administrator request unconfirmed");
});
