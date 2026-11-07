import test from "node:test";
import assert from "node:assert/strict";
import { handleAdminRequest } from "../src/admin-api.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

const token = "a".repeat(43);
function envWithCoordinator(handler) { return { ADMIN_TOKEN: token, COORDINATOR: { idFromName: (name) => name,
  get: () => ({ fetch: handler }) } }; }
function request(path, { method = "GET", bearer = token, body } = {}) {
  return new Request(`https://worker.example${path}`, { method, headers: { authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("admin status requires a configured correct secret", async () => {
  assert.equal((await handleAdminRequest(request("/v1/admin/status"), {})).status, 503);
  const env = envWithCoordinator(async () => Response.json({ phase: "WAITING" }));
  assert.equal((await handleAdminRequest(request("/v1/admin/status", { bearer: "wrong" }), env)).status, 401);
  const result = await handleAdminRequest(request("/v1/admin/status"), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { phase: "WAITING" });
});

test("configuration is validated, versioned and cannot enable incomplete activation", async () => {
  let calls = 0;
  const env = envWithCoordinator(async (_url, init) => { calls++; assert.equal(JSON.parse(init.body).expectedRevision, 3);
    return Response.json({ revision: 4, configGeneration: 1 }); });
  const put = (config) => request("/v1/admin/config", { method: "PUT", body: { config, expectedRevision: 3 } });
  assert.equal((await handleAdminRequest(put({ ...DEFAULT_CONFIG, autoEnabled: true }), env)).status, 409);
  assert.equal((await handleAdminRequest(put({ ...DEFAULT_CONFIG, timeZone: "bad-zone" }), env)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await handleAdminRequest(put(DEFAULT_CONFIG), env)).status, 200);
  assert.equal(calls, 1);
});

test("manual probe is gated and requires administrator authentication", async () => {
  let calls = 0;
  const env = envWithCoordinator(async (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, "/manual-probe");
    assert.deepEqual(JSON.parse(init.body), { expectedRevision: 2 });
    return Response.json({ outcome: "accepted", attemptId: "id", revision: 4 });
  });
  const make = (bearer = token) => request("/v1/admin/probe", { method: "POST", bearer, body: { expectedRevision: 2 } });
  assert.equal((await handleAdminRequest(make(), env)).status, 503);
  assert.equal((await handleAdminRequest(make("wrong"), { ...env, PROBE_DISPATCH_ENABLED: "true" })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handleAdminRequest(make(), { ...env, PROBE_DISPATCH_ENABLED: "true" })).status, 200);
  assert.equal(calls, 1);
});

test("conservative enrollment and local models require authentication and explicit gating", async () => {
  const forwarded = [];
  const env = { ...envWithCoordinator(async (url, init) => {
    forwarded.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return Response.json({ revision: 4 });
  }), ACTIVATION_ENABLED: "true" };
  const enroll = (bearer = token, acknowledged = true) => request("/v1/admin/conservative/enroll", {
    method: "POST", bearer, body: { acknowledged, expectedRevision: 3 } });
  assert.equal((await handleAdminRequest(enroll(), { ...env, ACTIVATION_ENABLED: "false" })).status, 503);
  assert.equal((await handleAdminRequest(enroll("wrong"), env)).status, 401);
  assert.equal((await handleAdminRequest(enroll(token, false), env)).status, 400);
  assert.equal((await handleAdminRequest(enroll(), env)).status, 200);
  const catalog = { cliVersion: "0.166.0", expectedRevision: 4, models: [{ id: "current-model" }] };
  assert.equal((await handleAdminRequest(request("/v1/admin/model-catalog", { method: "POST", body: catalog }), env)).status, 200);
  assert.deepEqual(forwarded.map((call) => call.path), ["/conservative/enroll", "/model-catalog"]);
  assert.equal((await handleAdminRequest(request("/v1/admin/model-catalog", { method: "POST", body: { ...catalog, models: [{ id: "x", auth: "secret" }] } }), env)).status, 400);
});

test("manual wake uses the same authenticated and gated coordinator entry", async () => {
  const env = { ...envWithCoordinator(async (url, init) => {
    assert.equal(new URL(url).pathname, "/manual-wake");
    assert.deepEqual(JSON.parse(init.body), { expectedRevision: 4 });
    return Response.json({ outcome: "skipped", reason: "waiting_for_estimate", revision: 4 });
  }), ACTIVATION_ENABLED: "true" };
  const req = () => request("/v1/admin/wake", { method: "POST", body: { expectedRevision: 4 } });
  assert.equal((await handleAdminRequest(req(), { ...env, ACTIVATION_ENABLED: "false" })).status, 503);
  assert.equal((await (await handleAdminRequest(req(), env)).json()).reason, "waiting_for_estimate");
});

test("manual test is administrator-only and uses a single expected revision", async () => {
  let calls = 0;
  const env = { ...envWithCoordinator(async (url, init) => {
    calls++; assert.equal(new URL(url).pathname, "/manual-test");
    assert.deepEqual(JSON.parse(init.body), { expectedRevision: 9 });
    return Response.json({ outcome: "accepted", attemptId: "id", runId: "101", revision: 11 });
  }), ACTIVATION_ENABLED: "true" };
  const req = (bearer = token) => request("/v1/admin/test-now", { method: "POST", bearer, body: { expectedRevision: 9 } });
  assert.equal((await handleAdminRequest(req("wrong"), env)).status, 401);
  assert.equal((await handleAdminRequest(req(), { ...env, ACTIVATION_ENABLED: "false" })).status, 503);
  assert.equal((await handleAdminRequest(req(), env)).status, 200);
  assert.equal(calls, 1);
});

test("release of a definitively rejected test requires administrator authorization", async () => {
  const body = { expectedRevision: 2, attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6" };
  let calls = 0;
  const env = envWithCoordinator(async (url, init) => {
    calls++;
    assert.equal(new URL(url).pathname, "/release-rejected-test");
    assert.deepEqual(JSON.parse(init.body), body);
    return Response.json({ revision: 3 });
  });
  const req = (bearer, data = body) => request("/v1/admin/release-rejected-test", { method: "POST", bearer, body: data });
  assert.equal((await handleAdminRequest(req("wrong"), env)).status, 401);
  assert.equal((await handleAdminRequest(req(token, { ...body, attemptId: "invalid" }), env)).status, 400);
  assert.equal((await handleAdminRequest(req(token), env)).status, 200);
  assert.equal(calls, 1);
});
