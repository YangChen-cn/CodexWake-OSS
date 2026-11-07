import test from "node:test";
import assert from "node:assert/strict";
import { remoteDashboard } from "../src/remote-dashboard.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

test("remote dashboard requires verified Access identity, same origin and revision CAS", async () => {
  const host = "dashboard.example";
  const origin = "https://" + host;
  const allowed = "owner@example.com";
  const ctx = { access: { aud: "dashboard-aud", getIdentity: async () => ({ email: allowed }) } };
  let state = { revision: 10, config: DEFAULT_CONFIG, automaticBlockReason: "activity_wakes_not_enabled",
    credentialGeneration: "private-metadata" };
  let writes = 0;
  const env = { DASHBOARD_HOST: host, DASHBOARD_ACCESS_AUD: "dashboard-aud", DASHBOARD_ALLOWED_EMAIL: allowed,
    COORDINATOR: { idFromName: (key) => key, get: () => ({ fetch: async (url, { method, body }) => {
      if (method === "GET") return Response.json(state);
      const data = JSON.parse(body);
      assert.equal(url, "https://coordinator.invalid/config");
      assert.equal(data.expectedRevision, state.revision);
      writes++;
      state = { ...state, revision: state.revision + 1, config: data.config };
      return Response.json({ revision: state.revision });
    } }) } };
  const cookie = "CF_Authorization=" + "a".repeat(60);
  const send = (path, { method = "GET", body, auth = ctx, settings = env, headers } = {}) =>
    remoteDashboard(new Request(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { cookie, "cf-access-authenticated-user-email": allowed, ...headers } }), settings, auth, { "/": ["<meta content='%%CSRF%%'>", "text/html"] });
  assert.equal((await send("/api/status", { auth: {} })).status, 403);
  assert.equal((await send("/api/status", { settings: { ...env, DASHBOARD_ACCESS_AUD: "" } })).status, 403);
  assert.equal((await send("/api/status", { auth: { access: { ...ctx.access, aud: "different" } } })).status, 403);
  assert.equal((await send("/api/status", { auth: { access: { ...ctx.access, getIdentity: async () => ({ email: "other@example.com" }) } } })).status, 403);
  const loginReturn = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  assert.equal((await send("/", { headers: loginReturn })).status, 200);
  assert.equal((await send("/api/csrf", { headers: loginReturn })).status, 403);
  const status = await (await send("/api/status")).json();
  assert.equal(status.cloud.revision, 10);
  assert.equal(JSON.stringify(status).includes("private-metadata"), false);
  const { csrf } = await (await send("/api/csrf")).json();
  const writeHeaders = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-codexwake-csrf": csrf };
  const { maxRetries, retryIntervalMinutes, ...settings } = DEFAULT_CONFIG;
  settings.allowedStart = "09:30";
  const config = { method: "PUT", body: { revision: 10, settings }, headers: writeHeaders };
  assert.equal((await send("/api/config", { ...config, headers: { ...writeHeaders, origin: "https://wrong.example" } })).status, 403);
  assert.equal((await send("/api/config", { ...config, headers: { ...writeHeaders, cookie: "CF_Authorization=" + "b".repeat(60) } })).status, 403);
  assert.equal((await send("/api/test-now", { method: "POST", body: { revision: 10 }, headers: writeHeaders })).status, 404);
  assert.equal((await send("/api/resume", { method: "POST", body: { revision: 10 }, headers: writeHeaders })).status, 409);
  assert.equal(writes, 0);
  assert.equal((await send("/api/config", config)).status, 200);
  assert.equal((await send("/api/config", config)).status, 409);
  assert.equal(writes, 1);
  assert.equal(state.config.allowedStart, "09:30");
});
