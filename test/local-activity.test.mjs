import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredWorker, handleActivityHook, inspectLocalLimits, runLocalObservation } from "../src/local-activity.mjs";
import { configureMonitor } from "../src/monitor-install.mjs";

test("local Worker configuration uses a private file or an explicit HTTPS origin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "worker-url"), "https://worker.example\n", { mode: 0o600 });
  assert.equal(await configuredWorker(root, {}), "https://worker.example");
  assert.equal(await configuredWorker(root, { CODEXWAKE_ADMIN_URL: "https://other.example" }), "https://other.example");
  await assert.rejects(configuredWorker(root, { CODEXWAKE_ADMIN_URL: "http://worker.example" }));
  await assert.rejects(configuredWorker(root, { CODEXWAKE_ADMIN_URL: "https://worker.example/path" }));
});

test("only a completed request paired with a local user prompt starts an observation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const turn = { session_id: "session", turn_id: "turn", prompt: "private content" };
  const started = { ...turn, hook_event_name: "UserPromptSubmit" };
  const finished = { ...turn, hook_event_name: "PostModelRequest", status: "completed" };
  const activity = [];
  const options = { root, env: {}, run: async (input) => activity.push(input.activity) };
  await handleActivityHook(finished, options);
  await handleActivityHook(started, options);
  await handleActivityHook({ ...finished, status: "failed" }, options);
  await handleActivityHook({ ...finished, agent_id: "subagent" }, options);
  assert.equal(activity.length, 0);
  await Promise.all([handleActivityHook(finished, options), handleActivityHook(finished, options)]);
  assert.equal(activity.length, 1);
  assert.match(activity[0].id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(activity).includes("private content"), false);
  await handleActivityHook(started, { ...options, env: { CI: "true" } });
  await handleActivityHook(finished, options);
  assert.equal(activity.length, 1);
});

test("a read-only observation and uncertain weekly or credit data never report activity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-observe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const bucket = {
    limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Math.ceil(now / 1000) + 1800 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.ceil(now / 1000) + 3600 },
    credits: { balance: "0", hasCredits: false, unlimited: false }, spendControlReached: false,
  };
  const limits = { ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: bucket } };
  let calls = 0;
  const result = await runLocalObservation({ root }, { observe: async () => ({ ...inspectLocalLimits(limits, now), accountTag: "b".repeat(64) }),
    report: async () => { calls++; } });
  assert.equal(result.usedPercent, 20);
  assert.equal(result.outcome, "read_only");
  assert.equal(calls, 0);
  assert.throws(() => inspectLocalLimits({ ...limits, rateLimitsByLimitId: { codex: { ...bucket, credits: null } } }, now), /uncertain/);
  assert.throws(() => inspectLocalLimits({ ...limits, rateLimitsByLimitId: { codex: { ...bucket, secondary: { ...bucket.secondary, usedPercent: 100 } } } }, now), /uncertain/);
});

test("hook install is idempotent and uninstall preserves existing hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "hooks.json");
  const existing = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }] } };
  await writeFile(path, JSON.stringify(existing), { mode: 0o600 });
  assert.equal((await configureMonitor("install", { root, path })).installed, true);
  await configureMonitor("install", { root, path });
  assert.equal(JSON.parse(await readFile(path, "utf8")).hooks.UserPromptSubmit.length, 2);
  assert.equal((await configureMonitor("uninstall", { root, path })).installed, false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), existing);
});
