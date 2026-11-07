import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { Coordinator } from "../src/coordinator.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { makeCredentialBundle, parseCredentialBundle } from "../src/credential-bundle.mjs";
import { initialState, readState, reserveManualTest, recordDispatchOutcome } from "../src/state.mjs";
import { handleRunnerRequest } from "../src/runner-api.mjs";
import { createRunnerCoordinator } from "../src/runner-coordinator.mjs";
import { runActivationAttempt } from "../src/runner-activation.mjs";
import { persistRefreshedCredential } from "../src/persist-credential.mjs";
import { verifyGitHubOidc } from "../src/github-oidc.mjs";

function storageFake(initial) {
  let value = structuredClone(initial);
  let tail = Promise.resolve();
  return { get: async () => structuredClone(value), transaction(callback) {
    const work = tail.then(async () => { let pending = structuredClone(value);
      const result = await callback({ get: async () => structuredClone(pending), put: async (_key, next) => { pending = structuredClone(next); } });
      value = pending; return result; });
    tail = work.catch(() => {}); return work;
  } };
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const time = (n) => `${String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((n % 1440) + 1440) % 60).padStart(2, "0")}`;

test("synthetic explicit manual activation uses OIDC, one permit, credential rotation and an honest report", async () => {
  await sodium.ready;
  const nowMs = Date.now();
  const minute = new Date(nowMs).getUTCHours() * 60 + new Date(nowMs).getUTCMinutes();
  const config = { ...DEFAULT_CONFIG, autoEnabled: false, model: "current-model", timeZone: "UTC", allowedStart: time(minute - 60),
    allowedEnd: time(minute + 60), sleepStart: time(minute + 600), sleepEnd: time(minute + 601) };
  const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } };
  const originalBundle = makeCredentialBundle(JSON.stringify(auth), from);
  const storage = storageFake({ ...initialState(), config, credentialGeneration: from,
    modelAttestation: { source: "local_model_list", model: "current-model", cliVersion: "0.166.0", verifiedAtMs: nowMs - 1000, expiresAtMs: nowMs + 86400000 } });
  await reserveManualTest(storage, { attemptId, expectedRevision: 0, nowMs });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });

  const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", rsa.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  const sha = "a".repeat(40);
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: "codexwake", repository_id: "123", repository_owner_id: "456",
    repository_visibility: "private", workflow_ref: "owner/repo/.github/workflows/wake.yml@refs/heads/main", ref: "refs/heads/main",
    workflow_sha: sha, event_name: "workflow_dispatch", runner_environment: "github-hosted", run_id: "101", run_attempt: "1",
    iat: Math.floor(nowMs / 1000) - 10, exp: Math.floor(nowMs / 1000) + 120 };
  const data = `${encode({ alg: "RS256", kid: "test-key" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(data));
  const jwt = `${data}.${Buffer.from(signature).toString("base64url")}`;
  const object = new Coordinator({ storage }, { ACTIVATION_ENABLED: "true" });
  const env = { ACTIVATION_ENABLED: "true", GITHUB_OIDC_AUDIENCE: "codexwake", GITHUB_OIDC_REPOSITORY_ID: "123", GITHUB_OIDC_OWNER_ID: "456",
    GITHUB_OIDC_WORKFLOW_REF: claims.workflow_ref, GITHUB_OIDC_REF: claims.ref, GITHUB_OIDC_WORKFLOW_SHA: sha,
    COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) } };
  const requests = [];
  const coordinator = createRunnerCoordinator({ baseUrl: "https://worker.example", getOidcToken: async () => jwt }, {
    fetch: async (url, init) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return handleRunnerRequest(new Request(url, init), env, { verify: (token, expected) =>
        verifyGitHubOidc(token, expected, { nowMs, fetch: async () => Response.json({ keys: [jwk] }) }) });
    },
  });
  const keys = sodium.crypto_box_keypair();
  let savedBundle;
  const githubOptions = { fetch: async (_url, init) => {
    if (init.method === "GET") return Response.json({ key_id: "key", key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL) });
    savedBundle = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(JSON.parse(init.body).encrypted_value, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey));
    return new Response(null, { status: 204 });
  } };
  let calls = 0;
  const result = await runActivationAttempt({ attemptId, originalBundle, codexPath: "/synthetic/codex", cliVersion: "0.166.0",
    observationMode: "local_attested", coordinator, limitId: "codex", githubConfig: { owner: "owner", repo: "repo", secretName: "CODEX_AUTH_BUNDLE", token: "synthetic-github" } }, {
    execute: async ({ codexHome }) => { calls++; await writeFile(join(codexHome, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "synthetic-new" } }));
      const now = Date.now(); return { outcome: "completed_unverified", startedAtMs: now, finishedAtMs: now }; },
    newGeneration: () => to,
    persist: (args) => persistRefreshedCredential(args, { githubOptions }),
  });
  assert.equal(result.outcome, "completed_unverified");
  assert.equal(calls, 1);
  assert.equal(parseCredentialBundle(savedBundle).generation, to);
  const state = await readState(storage);
  assert.equal(state.credentialGeneration, to);
  assert.equal(state.phase, "WAITING");
  assert.equal(state.lastActivation.beforeSnapshot, null);
  assert.equal(state.lastActivation.afterSnapshot, null);
  assert.equal(JSON.stringify(requests).includes("synthetic-refresh"), false);
  assert.equal(requests.filter((item) => item.path.endsWith("activation/authorize")).length, 1);
});
