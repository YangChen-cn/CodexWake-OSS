import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createGitHubOidcProvider, createRunnerCoordinator } from "../src/runner-coordinator.mjs";
import { runProbeAttempt } from "../src/runner-probe.mjs";

// Only reads the scheduled attempt's quota; it cannot send a model message.
// OAuth, GitHub and OIDC secrets stay in this process and are never logged.
export async function probeFromEnvironment(env, options = {}) {
  const required = ["CODEXWAKE_ATTEMPT_ID", "CODEX_AUTH_BUNDLE", "CODEXWAKE_CODEX_PATH", "CODEXWAKE_LIMIT_ID",
    "CODEXWAKE_WORKER_URL", "CODEXWAKE_OIDC_AUDIENCE", "CODEXWAKE_GITHUB_OWNER", "CODEXWAKE_GITHUB_REPO",
    "CODEXWAKE_SECRETS_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (required.some((name) => typeof env[name] !== "string" || !env[name]) || !isAbsolute(env.CODEXWAKE_CODEX_PATH)) {
    throw new Error("Missing runner probe configuration");
  }
  const getOidcToken = (options.createOidc ?? createGitHubOidcProvider)({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience: env.CODEXWAKE_OIDC_AUDIENCE });
  const coordinator = (options.createCoordinator ?? createRunnerCoordinator)({ baseUrl: env.CODEXWAKE_WORKER_URL, getOidcToken });
  return (options.runProbe ?? runProbeAttempt)({ attemptId: env.CODEXWAKE_ATTEMPT_ID, originalBundle: env.CODEX_AUTH_BUNDLE,
    codexPath: env.CODEXWAKE_CODEX_PATH, limitId: env.CODEXWAKE_LIMIT_ID, coordinator,
    githubConfig: { owner: env.CODEXWAKE_GITHUB_OWNER, repo: env.CODEXWAKE_GITHUB_REPO,
      secretName: "CODEX_AUTH_BUNDLE", token: env.CODEXWAKE_SECRETS_TOKEN } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeFromEnvironment(process.env);
    // Never print raw quota, model output, temporary credential paths or env.
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) })}\n`);
    if (result.outcome !== "probe_complete") process.exitCode = 1;
  } catch {
    process.stderr.write("Runner probe failed. Inspect sanitized status and recovery documentation.\n");
    process.exitCode = 1;
  }
}
