import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startDashboard } from "../src/dashboard-server.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

test("dashboard rejects rebinding and CSRF, saves through revision-checked admin channel", async (t) => {
  let cloud = { revision: 1, phase: "WAITING", config: { ...DEFAULT_CONFIG }, credentialGeneration: "never-return-this" };
  let probeCalls = 0;
  const { server, origin } = await startDashboard({
    monitor: async () => ({ installed: false }),
    observe: async () => { probeCalls++; return { outcome: "read_only" }; },
    admin: {
      status: async () => cloud,
      setConfig: async ({ config, expectedRevision }) => {
        assert.equal(expectedRevision, cloud.revision);
        cloud = { ...cloud, revision: cloud.revision + 1, config };
        return { revision: cloud.revision };
      },
      cancelWake: async ({ expectedRevision }) => ({ revision: expectedRevision + 1 }),
    },
  });
  t.after(() => server.close());
  assert.equal(server.address().address, "127.0.0.1");
  const rebinding = await new Promise((resolve, reject) => {
    request(origin, { headers: { Host: "foreign.example" } }, (res) => { res.resume(); resolve(res.statusCode); })
      .on("error", reject).end();
  });
  assert.equal(rebinding, 403);
  const html = await (await fetch(origin)).text();
  const csrf = html.match(/name="codexwake-csrf" content="([^"]+)"/)[1];
  const status = await (await fetch(origin + "/api/status")).text();
  assert.equal(status.includes("never-return-this"), false);
  assert.equal(probeCalls, 0, "dashboard status does not probe");
  const send = (path, body, headers = {}) => fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json", origin, "x-codexwake-csrf": csrf, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await send("/api/quota", {}, { origin: "http://localhost:5555" })).status, 403);
  assert.equal((await send("/api/quota", {}, { "x-codexwake-csrf": "incorrect" })).status, 403);
  assert.equal((await fetch(origin + "/api/csrf", { headers: { origin: "http://localhost:5555" } })).status, 403);
  assert.deepEqual(await (await fetch(origin + "/api/csrf")).json(), { csrf });
  assert.equal(probeCalls, 0);
  assert.equal((await send("/api/quota", {})).status, 200);
  assert.equal(probeCalls, 1);
  const { maxRetries, retryIntervalMinutes, ...settings } = DEFAULT_CONFIG;
  settings.allowedStart = "09:00";
  assert.equal((await send("/api/config", { settings, revision: 1 })).status, 200);
  assert.equal((await send("/api/config", { settings, revision: 1 })).status, 409);
  const saved = await (await fetch(origin + "/api/status")).json();
  assert.equal(saved.cloud.config.allowedStart, "09:00");
  assert.equal(saved.cloud.config.maxRetries, maxRetries);
  assert.equal(saved.cloud.config.retryIntervalMinutes, retryIntervalMinutes);
});

test("a login-managed dashboard stays available and cannot be shut down by the page", async (t) => {
  const { server, origin } = await startDashboard({ idleMs: null });
  t.after(() => server.close());
  const html = await (await fetch(origin)).text();
  assert.match(html, /<footer hidden>/);
  const csrf = html.match(/name="codexwake-csrf" content="([^"]+)"/)[1];
  const exit = await fetch(origin + "/api/exit", {
    method: "POST", headers: { "content-type": "application/json", origin, "x-codexwake-csrf": csrf }, body: "{}",
  });
  assert.equal(exit.status, 409);
  assert.equal((await exit.json()).error, "dashboard_managed");
  assert.equal((await fetch(origin)).status, 200);
});
