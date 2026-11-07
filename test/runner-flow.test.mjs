import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { Coordinator } from "../src/coordinator.mjs";
import { makeCredentialBundle, parseCredentialBundle } from "../src/credential-bundle.mjs";
import { verifyGitHubOidc } from "../src/github-oidc.mjs";
import { persistRefreshedCredential } from "../src/persist-credential.mjs";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { handleRunnerRequest } from "../src/runner-api.mjs";
import { createRunnerCoordinator } from "../src/runner-coordinator.mjs";
import { runProbeAttempt } from "../src/runner-probe.mjs";
import { initialState, readState, reservePreflight, recordDispatchOutcome } from "../src/state.mjs";

function storageFake(initial) {
  let state = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    get: async () => structuredClone(state),
    transaction(callback) {
      const run = tail.then(async () => {
        let pending = structuredClone(state);
        const result = await callback({ get: async () => structuredClone(pending), put: async (_key, value) => { pending = structuredClone(value); } });
        state = pending;
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const clockText = (minutes) => `${String(Math.floor((minutes + 1440) % 1440 / 60)).padStart(2, "0")}:${String((minutes + 1440) % 60).padStart(2, "0")}`;

test("synthetic Runner uses signed OIDC and persists refreshed credential through fenced coordinator", async () => {
  await sodium.ready;
  const nowMs = Date.now();
  const currentMinute = new Date(nowMs).getUTCHours() * 60 + new Date(nowMs).getUTCMinutes();
  const config = { ...DEFAULT_CONFIG, autoEnabled: true, timeZone: "UTC",
    allowedStart: clockText(currentMinute - 60), allowedEnd: clockText(currentMinute + 60),
    sleepStart: clockText(currentMinute + 600), sleepEnd: clockText(currentMinute + 601) };
  const from = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const to = "a4d82411-6583-44c1-9a42-60b512cc8bc6";
  const attemptId = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } };
  const originalBundle = makeCredentialBundle(JSON.stringify(auth), from);
  const storage = storageFake({ ...initialState(), config, credentialGeneration: from, quotaSnapshot: {
    source: "account/rateLimits/read", windowDurationMins: 300, observedAtMs: nowMs - 3600000, resetAtMs: nowMs - 121000,
  } });
  await reservePreflight(storage, { attemptId, expectedRevision: 0, nowMs });
  await recordDispatchOutcome(storage, { attemptId, outcome: "accepted", runId: "101" });

  const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", rsa.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  const workflowSha = "a".repeat(40);
  const claims = { iss: "https://token.actions.githubusercontent.com", aud: "codexwake", repository_id: "123",
    repository_owner_id: "456", repository_visibility: "private", workflow_ref: "owner/repo/.github/workflows/wake.yml@refs/heads/main",
    ref: "refs/heads/main", workflow_sha: workflowSha, event_name: "workflow_dispatch", runner_environment: "github-hosted",
    run_id: "101", run_attempt: "1", iat: Math.floor(nowMs / 1000) - 10, exp: Math.floor(nowMs / 1000) + 120 };
  const jwtData = `${encode({ alg: "RS256", kid: "test-key" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(jwtData));
  const token = `${jwtData}.${Buffer.from(signature).toString("base64url")}`;
  const coordinatorObject = new Coordinator({ storage });
  const env = { GITHUB_OIDC_AUDIENCE: "codexwake", GITHUB_OIDC_REPOSITORY_ID: "123", GITHUB_OIDC_OWNER_ID: "456",
    GITHUB_OIDC_WORKFLOW_REF: claims.workflow_ref, GITHUB_OIDC_REF: claims.ref, GITHUB_OIDC_WORKFLOW_SHA: workflowSha,
    COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: (url, init) => coordinatorObject.fetch(new Request(url, init)) }) } };
  const requests = [];
  const coordinator = createRunnerCoordinator({ baseUrl: "https://worker.example", getOidcToken: async () => token }, {
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return handleRunnerRequest(new Request(url, init), env, {
        verify: (jwt, expected) => verifyGitHubOidc(jwt, expected, { nowMs, fetch: async () => Response.json({ keys: [jwk] }) }),
      });
    },
  });
  const box = sodium.crypto_box_keypair();
  let savedBundle;
  const githubOptions = { fetch: async (url, init) => {
    if (init.method === "GET") return Response.json({ key_id: "key-1", key: sodium.to_base64(box.publicKey, sodium.base64_variants.ORIGINAL) });
    assert.equal(init.method, "PUT");
    const encrypted = sodium.from_base64(JSON.parse(init.body).encrypted_value, sodium.base64_variants.ORIGINAL);
    savedBundle = sodium.to_string(sodium.crypto_box_seal_open(encrypted, box.publicKey, box.privateKey));
    return new Response(null, { status: 204 });
  } };
  let codexHome;
  let closed = false;
  const result = await runProbeAttempt({ attemptId, originalBundle, codexPath: "/synthetic/codex", coordinator, limitId: "codex",
    githubConfig: { owner: "owner", repo: "repo", secretName: "CODEX_AUTH_BUNDLE", token: "synthetic-github" } }, {
    startCodex: (args) => { codexHome = args.codexHome; return { closeAndWait: async () => { closed = true; } }; },
    probe: async () => { await writeFile(join(codexHome, "auth.json"), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "synthetic-new" } }));
      return { planType: "plus", models: [], limits: { rateLimits: { limitId: "codex", primary: {
        windowDurationMins: 300, resetsAt: Math.floor(nowMs / 1000) + 18000, usedPercent: 1,
      } } } }; },
    now: () => nowMs,
    newGeneration: () => to,
    persist: async (args) => { assert.equal(closed, true); return persistRefreshedCredential(args, { githubOptions }); },
  });
  assert.equal(result.outcome, "probe_complete");
  assert.equal(result.credential, "updated");
  assert.equal(parseCredentialBundle(savedBundle).generation, to);
  assert.equal((await readState(storage)).credentialGeneration, to);
  assert.equal(requests.length, 5);
  assert.equal((await readState(storage)).phase, "WAITING");
  assert.equal(JSON.stringify(requests).includes("synthetic-refresh"), false);
  const replay = await runProbeAttempt({ attemptId, originalBundle, codexPath: "/synthetic/codex", coordinator, limitId: "codex", githubConfig: {} });
  assert.deepEqual(replay, { outcome: "blocked", reason: "claim_unconfirmed" });
});
