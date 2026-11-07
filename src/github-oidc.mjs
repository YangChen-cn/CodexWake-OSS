// GitHub's issuer and key endpoint are fixed; never trust URLs from a token.
import { readBoundedJson } from "./http-utils.mjs";
const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Malformed JWT encoding");
  }
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}

function decodeJson(value) {
  const result = JSON.parse(decoder.decode(decodeBase64Url(value)));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Malformed JWT object");
  return result;
}

// No endpoint uses this verifier until the complete claim/reservation
// protocol is implemented. The caller supplies deployment-owned constraints.
export async function verifyGitHubOidc(token, expected, options = {}) {
  const required = ["audience", "repositoryId", "repositoryOwnerId", "workflowRef", "ref", "workflowSha"];
  if (!expected || required.some((key) => typeof expected[key] !== "string" || !expected[key])) {
    throw new Error("Incomplete OIDC trust configuration");
  }
  if (!/^[a-f0-9]{40}$/i.test(expected.workflowSha)) throw new Error("Invalid trusted workflow SHA");
  if (typeof token !== "string" || token.length > 16384) throw new Error("Invalid JWT");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.crit !== undefined) {
    throw new Error("Unsupported JWT header");
  }
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid OIDC timeout");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let jwks;
  try {
    const response = await fetchFn(JWKS_URL, { redirect: "manual", signal: controller.signal });
    if (!response.ok) throw new Error("GitHub OIDC keys unavailable");
    jwks = await readBoundedJson(response, 65536);
  } catch { throw new Error("GitHub OIDC keys unavailable"); }
  finally { clearTimeout(timeout); }
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new Error("Invalid GitHub OIDC key set");
  const matches = jwks.keys.filter((key) => key.kid === header.kid && key.kty === "RSA" &&
    (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig"));
  if (matches.length !== 1) throw new Error("Unknown or ambiguous GitHub OIDC key");
  if (typeof matches[0].n !== "string" || decodeBase64Url(matches[0].n).length < 256) throw new Error("GitHub OIDC RSA key is too small");
  const key = await crypto.subtle.importKey("jwk", matches[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const validSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!validSignature) throw new Error("Invalid GitHub OIDC signature");

  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30))) {
    throw new Error("GitHub OIDC token is expired or not yet valid");
  }
  const audienceMatches = claims.aud === expected.audience ||
    (Array.isArray(claims.aud) && claims.aud.includes(expected.audience));
  if (claims.iss !== ISSUER || !audienceMatches || claims.repository_id !== expected.repositoryId ||
      claims.repository_owner_id !== expected.repositoryOwnerId || claims.repository_visibility !== "private" ||
      claims.workflow_ref !== expected.workflowRef || claims.ref !== expected.ref ||
      claims.workflow_sha !== expected.workflowSha || claims.event_name !== "workflow_dispatch" ||
      claims.runner_environment !== "github-hosted" ||
      typeof claims.run_id !== "string" || !/^[1-9]\d*$/.test(claims.run_id) ||
      typeof claims.run_attempt !== "string" || !/^[1-9]\d*$/.test(claims.run_attempt)) {
    throw new Error("GitHub OIDC claims do not match the trusted workflow");
  }
  return { runId: claims.run_id, runAttempt: claims.run_attempt, workflowSha: claims.workflow_sha };
}
