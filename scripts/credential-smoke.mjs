import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseCredentialBundle } from "../src/credential-bundle.mjs";
import { createGitHubOidcProvider } from "../src/runner-coordinator.mjs";

// Validates the actual queued Secret and OIDC without restoring auth.json,
// refreshing credentials or sending a model message. No secrets are printed.
export async function credentialSmokeFromEnvironment(env, options = {}) {
  const bundle = parseCredentialBundle(env.CODEX_AUTH_BUNDLE);
  const base = new URL(env.CODEXWAKE_WORKER_URL);
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid Worker URL");
  const getToken = (options.createOidc ?? createGitHubOidcProvider)({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience: env.CODEXWAKE_OIDC_AUDIENCE });
  const token = await getToken();
  const response = await (options.fetch ?? fetch)(new URL("/v1/runner/claim", base), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: randomUUID(), credentialGeneration: bundle.generation }),
  });
  if (response.status !== 409) throw new Error("Credential smoke did not reach the coordinator");
  return { outcome: "credential_schema_and_oidc_verified" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await credentialSmokeFromEnvironment(process.env))}\n`); }
  catch { process.stderr.write("Credential smoke test failed; no credential data was printed.\n"); process.exitCode = 1; }
}
