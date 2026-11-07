import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeCredentialBundle } from "../src/credential-bundle.mjs";
import { ReadOnlyAppServer } from "../src/app-server.mjs";
import { runProbeAttempt } from "../src/runner-probe.mjs";

const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const next = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const auth = { auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } };
const originalBundle = makeCredentialBundle(JSON.stringify(auth), generation);
const config = { attemptId, originalBundle, codexPath: "/synthetic/codex", limitId: "codex", githubConfig: {} };

test("a real child refresh during shutdown is persisted after its exit", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/refresh-on-shutdown.mjs", import.meta.url));
  let persistedRefresh;
  const result = await runProbeAttempt({ ...config, coordinator: { claim: async () => {} } }, {
    startCodex: ({ codexHome }) => new ReadOnlyAppServer(spawn(process.execPath, [fixture], {
      env: { CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "ignore"],
    })),
    probe: async (client) => { await client.initialize(); throw new Error("synthetic probe failure"); },
    persist: async ({ updatedAuth }) => {
      persistedRefresh = JSON.parse(updatedAuth).tokens.refresh_token;
      return { outcome: "updated" };
    },
  });
  assert.equal(persistedRefresh, "synthetic-refreshed-on-shutdown");
  assert.equal(result.reason, "quota_probe_failed");
});

test("a failed probe still saves a refreshed file after child shutdown", async () => {
  let directory;
  let closed = false;
  const calls = [];
  const coordinator = { claim: async (input) => calls.push(input) };
  const result = await runProbeAttempt({ ...config, coordinator }, {
    startCodex: ({ codexHome }) => { directory = codexHome; return { closeAndWait: async () => { closed = true; } }; },
    probe: async () => { await writeFile(join(directory, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "new-synthetic" } })); throw new Error("probe failed"); },
    newGeneration: () => next,
    persist: async ({ updatedAuth, nextGeneration }) => { assert.equal(closed, true); assert.equal(JSON.parse(updatedAuth).tokens.refresh_token, "new-synthetic"); assert.equal(nextGeneration, next); return { outcome: "updated" }; },
  });
  assert.deepEqual(calls, [{ attemptId, credentialGeneration: generation }]);
  assert.deepEqual(result, { outcome: "failed", reason: "quota_probe_failed", credential: "updated" });
  await assert.rejects(access(directory));
});

test("unconfirmed persistence retains the private credential for recovery", async () => {
  let directory;
  const result = await runProbeAttempt({ ...config, coordinator: { claim: async () => {} } }, {
    startCodex: ({ codexHome }) => { directory = codexHome; return { closeAndWait: async () => {} }; },
    probe: async () => { throw new Error("synthetic failure"); },
    persist: async () => ({ outcome: "pending" }),
  });
  try {
    assert.equal(result.outcome, "pending");
    assert.equal((await readFile(join(directory, "auth.json"), "utf8")).includes("synthetic-refresh"), true);
    assert.equal(JSON.stringify(result).includes("synthetic-refresh"), false);
  } finally { await rm(result.recoveryDirectory, { recursive: true, force: true }); }
});

test("a rejected claim never starts Codex", async () => {
  const result = await runProbeAttempt({ ...config, coordinator: { claim: async () => { throw new Error("not allowed"); } } }, {
    startCodex: () => { throw new Error("unexpected"); },
    retryOptions: { delayMs: 0 },
  });
  assert.deepEqual(result, { outcome: "blocked", reason: "claim_unconfirmed" });
});

test("a lost report retains the snapshot without sending a model message", async () => {
  const nowMs = Date.parse("2026-11-05T04:00:00Z");
  const coordinator = { claim: async () => {}, complete: async () => { throw new Error("response lost"); } };
  const result = await runProbeAttempt({ ...config, coordinator }, {
    startCodex: () => ({ closeAndWait: async () => {} }),
    probe: async () => ({ planType: "plus", models: [], limits: { rateLimits: { limitId: "codex", primary: {
      windowDurationMins: 300, resetsAt: Math.floor(nowMs / 1000) + 18000, usedPercent: 1,
    } } } }),
    now: () => nowMs,
    retryOptions: { delayMs: 0 },
    persist: async () => ({ outcome: "unchanged" }),
  });
  assert.equal(result.outcome, "pending");
  assert.equal(result.reason, "report_unconfirmed");
  assert.equal(result.snapshot.limitId, "codex");
  assert.equal(JSON.stringify(result).includes("synthetic-refresh"), false);
});
