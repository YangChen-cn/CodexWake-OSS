import test from "node:test";
import assert from "node:assert/strict";
import { configureFromEnvironment } from "../scripts/config.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";

const env = { CODEXWAKE_ADMIN_URL: "https://worker.example", CODEXWAKE_ADMIN_TOKEN: "a".repeat(43),
  CODEXWAKE_CONFIG_FILE: "/private/config.json" };

test("config command sets only a validated file with current revision", async () => {
  let input;
  const result = await configureFromEnvironment("set", env, {
    createAdmin: () => ({ status: async () => ({ revision: 7 }), setConfig: async (value) => { input = value; return { revision: 8 }; } }),
    readFile: async () => Buffer.from(JSON.stringify(DEFAULT_CONFIG)),
  });
  assert.equal(input.expectedRevision, 7);
  assert.deepEqual(input.config, DEFAULT_CONFIG);
  assert.deepEqual(result, { revision: 8 });
});

test("config command rejects relative paths and invalid config", async () => {
  await assert.rejects(configureFromEnvironment("set", { ...env, CODEXWAKE_CONFIG_FILE: "config.json" },
    { createAdmin: () => ({}) }), /absolute/);
  await assert.rejects(configureFromEnvironment("set", env, { createAdmin: () => ({}), readFile: async () => Buffer.from("{}") }));
});

test("manual probe command uses the latest revision and does not read a config file", async () => {
  let revision;
  const result = await configureFromEnvironment("probe", env, { createAdmin: () => ({
    status: async () => ({ revision: 7 }), startProbe: async (input) => { revision = input.expectedRevision; return { outcome: "accepted" }; },
  }), readFile: async () => { throw new Error("unexpected"); } });
  assert.equal(revision, 7);
  assert.equal(result.outcome, "accepted");
});

test("disable preserves the current settings and uses the current revision", async () => {
  let update;
  const result = await configureFromEnvironment("disable", { CODEXWAKE_ADMIN_URL: "https://worker.example", CODEXWAKE_ADMIN_TOKEN: "synthetic" }, {
    createAdmin: () => ({ status: async () => ({ revision: 12, config: { ...DEFAULT_CONFIG, autoEnabled: true, model: "current-model" } }),
      setConfig: async (value) => { update = value; return { revision: 13 }; } }),
  });
  assert.equal(result.revision, 13);
  assert.equal(update.expectedRevision, 12);
  assert.equal(update.config.autoEnabled, false);
  assert.equal(update.config.model, "current-model");
});

test("enable reports the rollout gate without sending a config update", async () => {
  let calls = 0;
  const options = { createAdmin: () => ({
    status: async () => ({ revision: 12, config: DEFAULT_CONFIG, automaticBlockReason: "activity_wakes_not_enabled" }),
    setConfig: async () => { calls++; },
  }) };
  await assert.rejects(configureFromEnvironment("enable", env, options), /currently unavailable/);
  assert.equal(calls, 0);
});

test("recovery requires explicit confirmation and a current revision", async () => {
  const env = { CODEXWAKE_ADMIN_URL: "https://worker.example", CODEXWAKE_ADMIN_TOKEN: "synthetic" };
  let calls = 0;
  const options = { createAdmin: () => ({ status: async () => ({ revision: 7 }), recover: async ({ expectedRevision }) => {
    calls++; assert.equal(expectedRevision, 7); return { revision: 8, reauthenticationRequired: true };
  } }) };
  await assert.rejects(configureFromEnvironment("recover", env, options), /confirmation/);
  assert.equal(calls, 0);
  assert.equal((await configureFromEnvironment("recover", { ...env, CODEXWAKE_CONFIRM_RECOVERY: "yes" }, options)).reauthenticationRequired, true);
});
