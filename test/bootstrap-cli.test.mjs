import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapFromEnvironment } from "../scripts/bootstrap.mjs";

const env = { CODEXWAKE_AUTH_FILE: "/private/isolated/auth.json", CODEXWAKE_ADMIN_URL: "https://worker.example",
  CODEXWAKE_ADMIN_TOKEN: "a".repeat(43), CODEXWAKE_GITHUB_OWNER: "owner", CODEXWAKE_GITHUB_REPO: "repo",
  CODEXWAKE_SECRETS_TOKEN: "synthetic-token" };
const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";

test("bootstrap command only reads explicitly supplied isolated file", async () => {
  const status = { phase: "WAITING", revision: 3, config: { autoEnabled: false }, credentialUpdatePending: false, credentialBootstrap: null };
  let seen;
  const result = await bootstrapFromEnvironment(env, {
    createAdmin: () => ({ status: async () => status }),
    readAuth: async (path) => { assert.equal(path, env.CODEXWAKE_AUTH_FILE); return "synthetic credential"; },
    newGeneration: () => generation,
    bootstrap: async (input) => { seen = input; return { outcome: "updated", generation }; },
  });
  assert.equal(seen.expectedRevision, 3);
  assert.equal(seen.generation, generation);
  assert.equal(seen.githubConfig.secretName, "CODEX_AUTH_BUNDLE");
  assert.equal(JSON.stringify(result).includes("synthetic credential"), false);
});

test("bootstrap command never retries an ambiguous Secret write", async () => {
  const status = { phase: "WAITING", revision: 4, config: { autoEnabled: false }, credentialUpdatePending: false,
    credentialBootstrap: { generation, writeState: "writing", digest: "a".repeat(64) } };
  const result = await bootstrapFromEnvironment(env, {
    createAdmin: () => ({ status: async () => status }),
    readAuth: async () => { throw new Error("must not read credentials"); },
    bootstrap: async () => { throw new Error("must not write secret"); },
  });
  assert.deepEqual(result, { outcome: "pending", reason: "manual_recovery_required", generation });
});
