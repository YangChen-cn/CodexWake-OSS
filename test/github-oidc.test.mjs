import test from "node:test";
import assert from "node:assert/strict";
import { verifyGitHubOidc } from "../src/github-oidc.mjs";

const nowMs = Date.parse("2026-11-04T04:00:00Z");
const expected = { audience: "codexwake", repositoryId: "123", repositoryOwnerId: "456",
  workflowRef: "owner/repo/.github/workflows/wake.yml@refs/heads/main",
  ref: "refs/heads/main", workflowSha: "a".repeat(40) };
const baseClaims = { iss: "https://token.actions.githubusercontent.com", aud: expected.audience,
  repository_id: expected.repositoryId, repository_owner_id: expected.repositoryOwnerId,
  repository_visibility: "private", workflow_ref: expected.workflowRef, ref: expected.ref,
  workflow_sha: expected.workflowSha, event_name: "workflow_dispatch", runner_environment: "github-hosted",
  run_id: "987", run_attempt: "1", iat: nowMs / 1000 - 10, exp: nowMs / 1000 + 60 };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const fetchKeys = async (url, init) => {
  assert.equal(url, "https://token.actions.githubusercontent.com/.well-known/jwks");
  assert.equal(init.redirect, "manual");
  return Response.json({ keys: [jwk] });
};
async function makeToken(claims, header = { alg: "RS256", kid: "test-key" }) {
  const data = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString("base64url")}`;
}

test("accepts a valid token for the pinned private workflow", async () => {
  const result = await verifyGitHubOidc(await makeToken(baseClaims), expected, { fetch: fetchKeys, nowMs });
  assert.deepEqual(result, { runId: "987", runAttempt: "1", workflowSha: expected.workflowSha });
});

test("rejects wrong claims, expiry, and unsafe headers", async () => {
  for (const claims of [
    { ...baseClaims, repository_id: "999" }, { ...baseClaims, repository_visibility: "public" },
    { ...baseClaims, workflow_sha: "b".repeat(40) }, { ...baseClaims, exp: nowMs / 1000 },
    { ...baseClaims, event_name: "push" }, { ...baseClaims, aud: "wrong" },
  ]) await assert.rejects(verifyGitHubOidc(await makeToken(claims), expected, { fetch: fetchKeys, nowMs }));
  await assert.rejects(verifyGitHubOidc(await makeToken(baseClaims, { alg: "none", kid: "test-key" }), expected, { fetch: fetchKeys, nowMs }));
});

test("rejects a tampered token and an ambiguous key set", async () => {
  const token = await makeToken(baseClaims);
  const parts = token.split(".");
  parts[1] = encode({ ...baseClaims, run_id: "988" });
  await assert.rejects(verifyGitHubOidc(parts.join("."), expected, { fetch: fetchKeys, nowMs }), /signature/);
  await assert.rejects(verifyGitHubOidc(token, expected, { fetch: async () => Response.json({ keys: [jwk, jwk] }), nowMs }), /ambiguous/);
});

test("rejects unavailable or oversized key sets without exposing response details", async () => {
  const token = await makeToken(baseClaims);
  await assert.rejects(verifyGitHubOidc(token, expected, { fetch: async () => new Response("x".repeat(65537)), nowMs }),
    (error) => error.message === "GitHub OIDC keys unavailable");
  await assert.rejects(verifyGitHubOidc(token, expected, { fetch: async () => { throw new Error("sensitive internal URL"); }, nowMs }),
    (error) => error.message === "GitHub OIDC keys unavailable");
});
