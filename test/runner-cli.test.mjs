import test from "node:test";
import assert from "node:assert/strict";
import { probeFromEnvironment } from "../scripts/runner-probe.mjs";

const env = { CODEXWAKE_ATTEMPT_ID: "attempt", CODEX_AUTH_BUNDLE: "synthetic-credential",
  CODEXWAKE_CODEX_PATH: "/trusted/codex", CODEXWAKE_LIMIT_ID: "codex", CODEXWAKE_WORKER_URL: "https://worker.example",
  CODEXWAKE_OIDC_AUDIENCE: "audience", CODEXWAKE_GITHUB_OWNER: "owner", CODEXWAKE_GITHUB_REPO: "repo",
  CODEXWAKE_SECRETS_TOKEN: "synthetic-github", ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/id",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc" };

test("runner probe passes credentials only to the parent-side coordinator", async () => {
  let runner;
  const result = await probeFromEnvironment(env, {
    createOidc: (args) => { assert.equal(args.requestToken, "synthetic-oidc"); return async () => "a.b.c"; },
    createCoordinator: (args) => { assert.equal(args.baseUrl, env.CODEXWAKE_WORKER_URL); return { sentinel: true }; },
    runProbe: async (args) => { runner = args; return { outcome: "probe_complete" }; },
  });
  assert.equal(runner.originalBundle, "synthetic-credential");
  assert.equal(runner.githubConfig.token, "synthetic-github");
  assert.equal(runner.githubConfig.secretName, "CODEX_AUTH_BUNDLE");
  assert.equal(runner.coordinator.sentinel, true);
  assert.deepEqual(result, { outcome: "probe_complete" });
});

test("runner probe refuses missing settings and non-absolute Codex path", async () => {
  await assert.rejects(probeFromEnvironment({ ...env, CODEXWAKE_CODEX_PATH: "codex" }), /configuration/);
  await assert.rejects(probeFromEnvironment({ ...env, CODEX_AUTH_BUNDLE: "" }), /configuration/);
});
