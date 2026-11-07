import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { bootstrapCredential } from "../src/bootstrap-credential.mjs";
import { readLocalAuthFile } from "../src/local-auth.mjs";

// The operator explicitly supplies all paths and credentials through the
// environment. Never echo environment variables or credential file content.
export async function bootstrapFromEnvironment(env, options = {}) {
  const names = ["CODEXWAKE_AUTH_FILE", "CODEXWAKE_ADMIN_URL", "CODEXWAKE_ADMIN_TOKEN", "CODEXWAKE_GITHUB_OWNER",
    "CODEXWAKE_GITHUB_REPO", "CODEXWAKE_SECRETS_TOKEN"];
  if (names.some((name) => typeof env[name] !== "string" || !env[name])) throw new Error("Missing bootstrap configuration");
  const admin = (options.createAdmin ?? createAdminCoordinator)({ baseUrl: env.CODEXWAKE_ADMIN_URL, adminToken: env.CODEXWAKE_ADMIN_TOKEN });
  const status = await admin.status();
  if (status.phase !== "WAITING" || status.config?.autoEnabled !== false || status.credentialUpdatePending !== false) {
    return { outcome: "blocked", reason: "coordinator_not_idle" };
  }
  const pending = status.credentialBootstrap;
  if (pending?.writeState === "writing") return { outcome: "pending", reason: "manual_recovery_required", generation: pending.generation };
  if (pending !== null && pending !== undefined && (pending.writeState !== "prepared" || typeof pending.generation !== "string")) {
    return { outcome: "blocked", reason: "invalid_bootstrap_state" };
  }
  const authText = await (options.readAuth ?? readLocalAuthFile)(env.CODEXWAKE_AUTH_FILE);
  const generation = env.CODEXWAKE_BOOTSTRAP_GENERATION || pending?.generation || (options.newGeneration ?? randomUUID)();
  return (options.bootstrap ?? bootstrapCredential)({ authText, generation, expectedRevision: status.revision, admin,
    githubConfig: { owner: env.CODEXWAKE_GITHUB_OWNER, repo: env.CODEXWAKE_GITHUB_REPO,
      secretName: "CODEX_AUTH_BUNDLE", token: env.CODEXWAKE_SECRETS_TOKEN } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await bootstrapFromEnvironment(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome !== "updated") process.exitCode = 1;
  } catch {
    process.stderr.write("Bootstrap failed. Check configuration and isolated credential file without printing secrets.\n");
    process.exitCode = 1;
  }
}
