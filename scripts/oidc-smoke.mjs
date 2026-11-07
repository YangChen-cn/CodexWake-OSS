import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createGitHubOidcProvider } from "../src/runner-coordinator.mjs";

function diagnosticClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const names = ["iss", "aud", "repository_id", "repository_owner_id", "repository_visibility", "workflow_ref", "ref", "workflow_sha", "event_name", "runner_environment", "run_id", "run_attempt"];
    return Object.fromEntries(names.map((name) => [name, typeof claims[name] === "string" ? claims[name].replace(/[^\x20-\x7e]/g, "?").slice(0, 300) : null]));
  } catch { return null; }
}

// Uses no OAuth or GitHub write secret. The deliberately unreserved attempt
// must reach the coordinator and be rejected with 409 after OIDC verification.
export async function smokeFromEnvironment(env, options = {}) {
  const audience = env.CODEXWAKE_OIDC_AUDIENCE;
  const base = new URL(env.CODEXWAKE_WORKER_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid Worker URL");
  const getToken = (options.createOidc ?? createGitHubOidcProvider)({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience });
  let token;
  try { token = await getToken(); }
  catch { throw new Error("oidc_provider_unavailable"); }
  const response = await (options.fetch ?? fetch)(new URL("/v1/runner/claim", base), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: randomUUID(), credentialGeneration: randomUUID() }),
  });
  if (response.status !== 409) {
    const error = new Error("worker_rejected_identity");
    error.status = response.status;
    error.claims = diagnosticClaims(token);
    throw error;
  }
  return { outcome: "oidc_verified" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await smokeFromEnvironment(process.env))}\n`); }
  catch (error) {
    const stage = ["oidc_provider_unavailable", "worker_rejected_identity"].includes(error?.message) ? error.message : "smoke_request_failed";
    process.stderr.write(`${JSON.stringify({ outcome: "failed", stage, ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      ...(stage === "worker_rejected_identity" ? { claims: error.claims } : {}) })}\n`);
    process.exitCode = 1;
  }
}
