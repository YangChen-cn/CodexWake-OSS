import test from "node:test";
import assert from "node:assert/strict";
import { activateFromEnvironment } from "../scripts/runner-activation.mjs";

const env = { CODEXWAKE_ATTEMPT_ID: "attempt", CODEX_AUTH_BUNDLE: "synthetic-auth", CODEXWAKE_CODEX_PATH: "/trusted/codex",
  CODEXWAKE_WORKER_URL: "https://worker.example", CODEXWAKE_OIDC_AUDIENCE: "audience", CODEXWAKE_GITHUB_OWNER: "owner",
  CODEXWAKE_GITHUB_REPO: "repo", CODEXWAKE_SECRETS_TOKEN: "synthetic-secret-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/id", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc" };

test("activation CLI uses the installed version and local-attested fallback", async () => {
  let args;
  const result = await activateFromEnvironment(env, {
    getVersion: async (path) => { assert.equal(path, env.CODEXWAKE_CODEX_PATH); return "0.166.0"; },
    createOidc: () => async () => "a.b.c", createCoordinator: () => ({ identity: true }),
    runActivation: async (input) => { args = input; return { outcome: "completed_unverified" }; },
  });
  assert.equal(result.outcome, "completed_unverified");
  assert.equal(args.cliVersion, "0.166.0");
  assert.equal(args.observationMode, "local_attested");
  assert.equal(args.githubConfig.secretName, "CODEX_AUTH_BUNDLE");
  assert.equal(args.coordinator.identity, true);
});

test("activation CLI rejects missing configuration and malformed version", async () => {
  await assert.rejects(activateFromEnvironment({ ...env, CODEX_AUTH_BUNDLE: "" }), /configuration/);
  await assert.rejects(activateFromEnvironment(env, { getVersion: async () => "unknown" }), /version/);
});
