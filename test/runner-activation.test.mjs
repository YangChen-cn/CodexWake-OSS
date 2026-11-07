import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeCredentialBundle } from "../src/credential-bundle.mjs";
import { runActivationAttempt } from "../src/runner-activation.mjs";

const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const auth = { auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } };
const originalBundle = makeCredentialBundle(JSON.stringify(auth), generation);
const now = Date.parse("2026-11-05T04:00:00Z");
const limits = { ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: { limitId: "codex",
  primary: { windowDurationMins: 300, resetsAt: now / 1000 + 18000, usedPercent: 0 },
  secondary: { windowDurationMins: 10080, resetsAt: now / 1000 + 604800, usedPercent: 4 } } } };
const config = { attemptId, originalBundle, codexPath: "/synthetic/codex", cliVersion: "0.166.0", limitId: "codex", githubConfig: {} };
const observed = { planType: "plus", limits, models: [{ id: "current-test-model" }] };
const options = { now: () => now, retryOptions: { delayMs: 0 } };

test("activation persists a refreshed credential before reporting observed quota", async () => {
  let home;
  let closed = 0;
  let calls = 0;
  let persisted = false;
  let report;
  const coordinator = { claim: async () => {}, authorizeActivation: async ({ models }) => {
    assert.equal(closed, 1); assert.deepEqual(models, observed.models); return { model: "current-test-model", message: "hello" };
  }, completeActivation: async (value) => { assert.equal(persisted, true); report = value; } };
  const result = await runActivationAttempt({ ...config, coordinator }, { ...options,
    startCodex: ({ codexHome }) => { home = codexHome; return { closeAndWait: async () => { closed++; } }; },
    probe: async () => observed,
    execute: async ({ model, message }) => {
      calls++; assert.equal(model, "current-test-model"); assert.equal(message, "hello");
      await writeFile(join(home, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "refreshed-synthetic" } }));
      return { outcome: "completed_unverified", startedAtMs: now, finishedAtMs: now };
    },
    persist: async ({ updatedAuth }) => { assert.equal(closed, 2); assert.equal(JSON.parse(updatedAuth).tokens.refresh_token, "refreshed-synthetic"); persisted = true; return { outcome: "updated" }; },
  });
  assert.deepEqual(result, { outcome: "completed_unverified", credential: "updated" });
  assert.equal(calls, 1);
  assert.equal(report.beforeSnapshot.limitId, "codex");
  assert.equal(report.afterSnapshot.limitId, "codex");
  await assert.rejects(access(home));
});

test("a lost one-shot permission never starts a model and still persists a probe refresh", async () => {
  let permitCalls = 0;
  let home;
  let persisted = false;
  const result = await runActivationAttempt({ ...config, coordinator: { claim: async () => {}, authorizeActivation: async () => {
    permitCalls++; throw new Error("response lost");
  } } }, { ...options,
    startCodex: ({ codexHome }) => { home = codexHome; return { closeAndWait: async () => {} }; },
    probe: async () => { await writeFile(join(home, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "refreshed-synthetic" } })); return observed; },
    execute: async () => { throw new Error("unexpected model request"); },
    persist: async ({ updatedAuth }) => { assert.equal(JSON.parse(updatedAuth).tokens.refresh_token, "refreshed-synthetic"); persisted = true; return { outcome: "updated" }; },
  });
  assert.equal(permitCalls, 1);
  assert.equal(persisted, true);
  assert.equal(result.reason, "permit_unconfirmed");
  await assert.rejects(access(home));
});

test("quota veto prevents a model request", async () => {
  const blockedLimits = { ...limits, ordinaryUsageAllowed: false };
  const result = await runActivationAttempt({ ...config, coordinator: { claim: async () => {},
    authorizeActivation: async () => { throw new Error("unexpected permission"); } } }, { ...options,
    startCodex: () => ({ closeAndWait: async () => {} }), probe: async () => ({ ...observed, limits: blockedLimits }),
    execute: async () => { throw new Error("unexpected request"); }, persist: async () => ({ outcome: "unchanged" }),
  });
  assert.equal(result.reason, "ordinary_usage_unconfirmed");
});

test("unconfirmed credential persistence retains the private file and never reports completion", async () => {
  let home;
  const result = await runActivationAttempt({ ...config, coordinator: { claim: async () => {},
    authorizeActivation: async () => ({ model: "current-test-model", message: "hello" }),
    completeActivation: async () => { throw new Error("must not report"); } } }, { ...options,
    startCodex: ({ codexHome }) => { home = codexHome; return { closeAndWait: async () => {} }; },
    probe: async () => observed,
    execute: async () => ({ outcome: "completed_unverified", startedAtMs: now, finishedAtMs: now }),
    persist: async () => ({ outcome: "pending" }),
  });
  try {
    assert.equal(result.reason, "credential_persistence_unconfirmed");
    assert.equal((await readFile(join(home, "auth.json"), "utf8")).includes("synthetic-refresh"), true);
    assert.equal(JSON.stringify(result).includes("synthetic-refresh"), false);
  } finally { await rm(result.recoveryDirectory, { recursive: true, force: true }); }
});

test("local-attested fallback never invokes hosted App Server or invents quota data", async () => {
  let report;
  let turns = 0;
  const coordinator = { claim: async () => {}, authorizeActivation: async (body) => {
    assert.deepEqual(body.models, []); assert.equal(body.cliVersion, "0.166.0"); return { model: "current-test-model", message: "hello" };
  }, completeActivation: async (value) => { report = value; } };
  const result = await runActivationAttempt({ ...config, coordinator, observationMode: "local_attested" }, { ...options,
    startCodex: () => { throw new Error("hosted App Server must not start"); },
    execute: async () => { turns++; return { outcome: "completed_unverified", startedAtMs: now, finishedAtMs: now }; },
    persist: async () => ({ outcome: "unchanged" }),
  });
  assert.equal(result.outcome, "completed_unverified");
  assert.equal(turns, 1);
  assert.equal(report.beforeSnapshot, null);
  assert.equal(report.afterSnapshot, null);
});
