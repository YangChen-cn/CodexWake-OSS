import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { initialState } from "../src/state.mjs";

test("SQLite Durable Object serializes conflicting configuration updates", async () => {
  const modules = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs", "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"]
    .map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  const send = (body) => mf.dispatchFetch("http://test/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const initial = await (await send({ operation: "read" })).json();
    assert.equal(initial.revision, 0);
    assert.equal(initial.config.autoEnabled, false);
    const responses = await Promise.all([
      send({ operation: "replace", config: { ...DEFAULT_CONFIG, allowedStart: "09:00" }, revision: 0 }),
      send({ operation: "replace", config: { ...DEFAULT_CONFIG, allowedStart: "10:00" }, revision: 0 }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const saved = await (await send({ operation: "read" })).json();
    assert.equal(saved.revision, 1);
    assert.equal(saved.configGeneration, 1);
    assert.ok(["09:00", "10:00"].includes(saved.config.allowedStart));
  } finally { await mf.dispose(); }
});

test("SQLite Durable Object fences duplicate preflights and credential rotation", async () => {
  const modules = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs", "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"]
    .map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  const send = (body) => mf.dispatchFetch("http://test/", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nowMs = Date.parse("2026-11-04T04:00:00Z");
  const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  try {
    const state = { ...initialState(), config: { ...DEFAULT_CONFIG, autoEnabled: true }, credentialGeneration: from,
      quotaSnapshot: { source: "account/rateLimits/read", windowDurationMins: 300,
        observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 120000 } };
    assert.equal((await send({ operation: "seed", state })).status, 200);
    const candidates = await Promise.all([
      send({ operation: "reserve", args: { attemptId, expectedRevision: 0, nowMs } }),
      send({ operation: "reserve", args: { attemptId: "51c854e8-23cc-4d57-8e1a-3078a9fd28d7", expectedRevision: 0, nowMs } }),
    ]);
    // Exactly one ID wins; use the winner rather than assuming network ordering.
    assert.deepEqual(candidates.map((response) => response.status).sort(), [200, 409]);
    const winner = await candidates.find((response) => response.status === 200).json();
    const chosen = winner.attempt.id;
    assert.equal((await send({ operation: "dispatch-outcome", args: { attemptId: chosen, outcome: "accepted", runId: "101" } })).status, 200);
    assert.equal((await send({ operation: "claim", args: { attemptId: chosen, credentialGeneration: from, identity, nowMs } })).status, 200);
    assert.equal((await send({ operation: "prepare", args: { attemptId: chosen, identity, from, to } })).status, 200);
    assert.equal((await send({ operation: "authorize-write", args: { attemptId: chosen, identity, to } })).status, 200);
    assert.equal((await send({ operation: "authorize-write", args: { attemptId: chosen, identity, to } })).status, 409);
    assert.equal((await send({ operation: "commit", args: { attemptId: chosen, identity: { runId: "102", runAttempt: "1" }, to } })).status, 409);
    assert.equal((await send({ operation: "commit", args: { attemptId: chosen, identity, to } })).status, 200);
    assert.equal((await (await send({ operation: "read" })).json()).credentialGeneration, to);
  } finally { await mf.dispose(); }
});

test("manual probe can establish the first quota snapshot in SQLite", async () => {
  const modules = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs", "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"]
    .map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  const send = (body) => mf.dispatchFetch("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nowMs = Date.parse("2026-11-04T16:00:00Z");
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  try {
    assert.equal((await send({ operation: "seed", state: { ...initialState(), credentialGeneration } })).status, 200);
    assert.equal((await send({ operation: "manual-reserve", args: { attemptId, expectedRevision: 0, nowMs } })).status, 200);
    assert.equal((await send({ operation: "dispatch-outcome", args: { attemptId, outcome: "accepted", runId: "101" } })).status, 200);
    assert.equal((await send({ operation: "claim", args: { attemptId, credentialGeneration, identity, nowMs } })).status, 200);
    const snapshot = { source: "account/rateLimits/read", limitId: "codex", windowDurationMins: 300,
      observedAtMs: nowMs, resetAtMs: nowMs + 18000000, usedPercent: 5 };
    assert.equal((await send({ operation: "complete", args: { attemptId, identity, snapshot, nowMs } })).status, 200);
    const state = await (await send({ operation: "read" })).json();
    assert.equal(state.phase, "WAITING");
    assert.equal(state.config.autoEnabled, false);
    assert.deepEqual(state.quotaSnapshot, snapshot);
  } finally { await mf.dispose(); }
});

test("SQLite allows only one activation permit and blocks failed attempts", async () => {
  const modules = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs", "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"]
    .map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  const send = (body) => mf.dispatchFetch("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  const start = Date.parse("2026-11-05T00:00:00Z");
  const nowMs = start + 5 * 60 * 60 * 1000 + 120000;
  try {
    assert.equal((await send({ operation: "seed", state: { ...initialState(), credentialGeneration } })).status, 200);
    assert.equal((await send({ operation: "enroll-estimate", args: { acknowledged: true, expectedRevision: 0, nowMs: start } })).status, 200);
    assert.equal((await send({ operation: "replace", config: { ...DEFAULT_CONFIG, autoEnabled: true, model: "test-current" }, revision: 1 })).status, 200);
    assert.equal((await send({ operation: "reserve-estimate", args: { attemptId, expectedRevision: 2, nowMs } })).status, 200);
    assert.equal((await send({ operation: "dispatch-outcome", args: { attemptId, outcome: "accepted", runId: "101" } })).status, 200);
    assert.equal((await send({ operation: "claim", args: { attemptId, credentialGeneration, identity, nowMs } })).status, 200);
    const permit = { operation: "authorize-activation", args: { attemptId, identity, models: [{ id: "test-current" }], nowMs } };
    const results = await Promise.all([send(permit), send(permit)]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await send({ operation: "complete-activation", args: { attemptId, identity, outcome: "unconfirmed",
      startedAtMs: nowMs, finishedAtMs: nowMs + 1000, nowMs: nowMs + 2000 } })).status, 200);
    assert.equal((await (await send({ operation: "read" })).json()).phase, "FAILED");
  } finally { await mf.dispose(); }
});

test("SQLite manual test bypasses the clock once without enabling automation", async () => {
  const modules = ["../fixtures/state-test-worker.mjs", "../src/state.mjs", "../src/activity-policy.mjs", "../src/wake-planning.mjs", "../src/policy.mjs", "../src/eligibility.mjs", "../src/conservative-window.mjs", "../src/model-selection.mjs"]
    .map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)), durableObjects: { TEST_OBJECT: { className: "TestCoordinator", useSQLite: true } } }));
  const send = (body) => mf.dispatchFetch("http://test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const credentialGeneration = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const identity = { runId: "101", runAttempt: "1" };
  const nowMs = Date.parse("2026-11-06T16:00:00Z"); // During Hong Kong sleep hours.
  try {
    const state = { ...initialState(), credentialGeneration, config: { ...DEFAULT_CONFIG, model: "current-model" },
      modelAttestation: { source: "local_model_list", model: "current-model", cliVersion: "0.166.0", verifiedAtMs: nowMs - 365 * 86400000, expiresAtMs: nowMs - 1 } };
    assert.equal((await send({ operation: "seed", state })).status, 200);
    assert.equal((await send({ operation: "reserve-manual-test", args: { attemptId, expectedRevision: 0, nowMs } })).status, 200);
    assert.equal((await send({ operation: "dispatch-outcome", args: { attemptId, outcome: "accepted", runId: "101" } })).status, 200);
    assert.equal((await send({ operation: "claim", args: { attemptId, credentialGeneration, identity, nowMs } })).status, 200);
    const permit = { operation: "authorize-activation", args: { attemptId, identity, models: [], cliVersion: "0.166.0", nowMs } };
    const requests = await Promise.all([send(permit), send(permit)]);
    assert.deepEqual(requests.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await send({ operation: "complete-activation", args: { attemptId, identity, outcome: "completed_unverified",
      startedAtMs: nowMs, finishedAtMs: nowMs + 1000, nowMs: nowMs + 2000 } })).status, 200);
    const saved = await (await send({ operation: "read" })).json();
    assert.equal(saved.config.autoEnabled, false);
    assert.equal(saved.phase, "WAITING");
  } finally { await mf.dispose(); }
});
