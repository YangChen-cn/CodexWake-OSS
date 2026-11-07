import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

test("production Worker authenticates admin and persists only disabled config", async () => {
  const paths = ["worker", "coordinator", "activity-api", "activity-policy", "wake-planning", "runner-api", "admin-api", "github-oidc", "github-dispatch", "dispatch-orchestrator", "http-utils", "policy", "state", "eligibility", "conservative-window", "model-selection", "notify", "recovery", "status-mirror"];
  const modules = paths.map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(`../src/${path}.mjs`, import.meta.url)) }));
  const token = "a".repeat(43);
  const reporter = "b".repeat(43);
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    compatibilityDate: "2026-10-01", bindings: { ADMIN_TOKEN: token, ACTIVITY_REPORT_TOKEN: reporter },
    durableObjects: { COORDINATOR: { className: "Coordinator", useSQLite: true } } }));
  const send = (path, { method = "GET", bearer = token, body } = {}) => mf.dispatchFetch(`http://test${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await send("/v1/admin/status", { bearer: "incorrect" })).status, 401);
    const first = await (await send("/v1/admin/status")).json();
    assert.equal(first.revision, 0);
    assert.equal(first.config.autoEnabled, false);
    assert.equal((await send("/v1/admin/config", { method: "PUT", body: { config: { ...DEFAULT_CONFIG, autoEnabled: true }, expectedRevision: 0 } })).status, 409);
    assert.equal((await send("/v1/admin/config", { method: "PUT", body: { config: { ...DEFAULT_CONFIG, allowedStart: "09:00" }, expectedRevision: 0 } })).status, 200);
    const saved = await (await send("/v1/admin/status")).json();
    assert.equal(saved.revision, 1);
    assert.equal(saved.config.allowedStart, "09:00");
    assert.equal((await send("/v1/admin/config", { method: "PUT", body: { config: DEFAULT_CONFIG, expectedRevision: 0 } })).status, 409);
    const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
    const digest = "a".repeat(64);
    assert.equal((await send("/v1/admin/bootstrap/prepare", { method: "POST", body: { generation, digest, expectedRevision: 1 } })).status, 200);
    assert.deepEqual((await (await send("/v1/admin/status")).json()).credentialBootstrap, { generation, digest, writeState: "prepared" });
    assert.equal((await send("/v1/admin/bootstrap/commit", { method: "POST", body: { generation, digest: "b".repeat(64) } })).status, 409);
    assert.equal((await send("/v1/admin/bootstrap/authorize-write", { method: "POST", body: { generation, digest } })).status, 200);
    assert.equal((await send("/v1/admin/bootstrap/authorize-write", { method: "POST", body: { generation, digest } })).status, 409);
    assert.equal((await send("/v1/admin/bootstrap/commit", { method: "POST", body: { generation, digest } })).status, 200);
    assert.equal((await (await send("/v1/admin/status")).json()).credentialBootstrap, null);
    assert.equal((await send("/v1/runner/claim", { method: "POST", body: {} })).status, 503);
    const now = Date.now();
    const resetAtMs = now + 3600000;
    const event = { version: 1, eventKind: "user_activity", eventId: "1".repeat(64), accountTag: "2".repeat(64),
      activityAtMs: now, observedAtMs: now, limitId: "codex", windowDurationMins: 300,
      resetAtMs, weekResetAtMs: now + 7200000, windowKey: `codex:300:${resetAtMs}`, usedPercent: 30 };
    const report = (bearer, body) => send("/v1/local/activity", { method: "POST", bearer, body });
    assert.equal((await send("/v1/admin/status", { bearer: reporter })).status, 401);
    assert.equal((await report(token, event)).status, 401);
    assert.equal((await report(reporter, { ...event, prompt: "no prompt allowed" })).status, 400);
    assert.equal((await (await report(reporter, event)).json()).outcome, "ignored");
    const activity = (await (await send("/v1/admin/status")).json()).activityWake;
    assert.equal(activity.status, "ignored");
    assert.equal(activity.usedPercent, 30);
    assert.equal(Object.hasOwn(activity, "accountTag"), false);
  } finally { await mf.dispose(); }
});
