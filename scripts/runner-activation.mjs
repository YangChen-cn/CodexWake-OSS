import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createGitHubOidcProvider, createRunnerCoordinator } from "../src/runner-coordinator.mjs";
import { runActivationAttempt } from "../src/runner-activation.mjs";

const execFileAsync = promisify(execFile);

async function installedCliVersion(codexPath) {
  const result = await execFileAsync(codexPath, ["--version"], {
    timeout: 10000, maxBuffer: 4096, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
  });
  const match = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(result.stdout);
  if (!match) throw new Error("Invalid Codex version");
  return match[1];
}

export async function activateFromEnvironment(env, options = {}) {
  const required = ["CODEXWAKE_ATTEMPT_ID", "CODEX_AUTH_BUNDLE", "CODEXWAKE_CODEX_PATH", "CODEXWAKE_WORKER_URL",
    "CODEXWAKE_OIDC_AUDIENCE", "CODEXWAKE_GITHUB_OWNER", "CODEXWAKE_GITHUB_REPO", "CODEXWAKE_SECRETS_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (required.some((name) => typeof env[name] !== "string" || !env[name]) || !isAbsolute(env.CODEXWAKE_CODEX_PATH)) {
    throw new Error("Missing runner activation configuration");
  }
  const cliVersion = await (options.getVersion ?? installedCliVersion)(env.CODEXWAKE_CODEX_PATH);
  if (typeof cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(cliVersion)) throw new Error("Invalid Codex version");
  const getOidcToken = (options.createOidc ?? createGitHubOidcProvider)({ requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, audience: env.CODEXWAKE_OIDC_AUDIENCE });
  const coordinator = (options.createCoordinator ?? createRunnerCoordinator)({ baseUrl: env.CODEXWAKE_WORKER_URL, getOidcToken });
  return (options.runActivation ?? runActivationAttempt)({ attemptId: env.CODEXWAKE_ATTEMPT_ID, originalBundle: env.CODEX_AUTH_BUNDLE,
    codexPath: env.CODEXWAKE_CODEX_PATH, cliVersion, limitId: "codex", observationMode: "local_attested", coordinator,
    githubConfig: { owner: env.CODEXWAKE_GITHUB_OWNER, repo: env.CODEXWAKE_GITHUB_REPO,
      secretName: "CODEX_AUTH_BUNDLE", token: env.CODEXWAKE_SECRETS_TOKEN } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await activateFromEnvironment(process.env);
    // Never print prompt, model output, quota data, auth, or recovery paths.
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}),
      ...(typeof result.responseReceived === "boolean" ? { responseReceived: result.responseReceived } : {}) })}\n`);
    if (result.outcome !== "completed_unverified") process.exitCode = 1;
  } catch {
    process.stderr.write("Activation failed. Consult sanitized status and recovery documentation.\n");
    process.exitCode = 1;
  }
}
