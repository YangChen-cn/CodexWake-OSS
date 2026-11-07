import { spawn, execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { startReadOnlyCodex, readOnlyProbe } from "../src/app-server.mjs";
import { readLocalAuthFile } from "../src/local-auth.mjs";
import { registerLocalAccount } from "../src/local-reauth.mjs";
import { configuredWorker } from "../src/local-activity.mjs";
import { readBoundedJson } from "../src/http-utils.mjs";

const execFileAsync = promisify(execFile);

async function runLogin(codexPath, codexHome) {
  const env = { PATH: process.env.PATH ?? "", HOME: homedir(), CODEX_HOME: codexHome, LANG: "C.UTF-8" };
  await new Promise((resolveLogin, reject) => {
    const child = spawn(codexPath, ["-c", 'cli_auth_credentials_store="file"', "login"], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 && signal === null ? resolveLogin() : reject(new Error("Login failed")));
  });
}

async function observeLocal(codexPath, codexHome) {
  const work = await mkdtemp(join(tmpdir(), "codexwake-reauth-"));
  let client;
  let shutdownConfirmed = false;
  try {
    client = startReadOnlyCodex({ codexPath, codexHome, cwd: work });
    return await readOnlyProbe(client);
  } finally {
    if (client) { await client.closeAndWait(); shutdownConfirmed = true; }
    else shutdownConfirmed = true;
    if (shutdownConfirmed) await rm(work, { recursive: true, force: true });
  }
}

async function localCliVersion(codexPath) {
  const result = await execFileAsync(codexPath, ["--version"], { timeout: 10000, maxBuffer: 4096,
    env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" } });
  const match = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(result.stdout);
  if (!match) throw new Error("Invalid Codex version");
  return match[1];
}

async function localGitHubToken(userHome) {
  const result = await execFileAsync("gh", ["auth", "token"], { timeout: 10000, maxBuffer: 8192,
    env: { PATH: process.env.PATH ?? "", HOME: userHome, USER: process.env.USER ?? "", LANG: "C.UTF-8" } });
  if (!result.stdout.trim()) throw new Error("GitHub login unavailable");
  return result.stdout.trim();
}

export async function assertPrivateRepository(owner, repo, token, fetchFn = fetch) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(10000), headers: {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "CodexWake/1.0",
  } });
  if (!response.ok) throw new Error("Could not verify the execution repository");
  const result = await readBoundedJson(response, 128 * 1024);
  if (result.private !== true || typeof result.full_name !== "string" ||
      result.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error("The execution repository must be private");
  }
}

export async function reauthenticateFromEnvironment(env, options = {}) {
  if (!options.allowNonInteractive && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Interactive terminal required");
  const owner = env.CODEXWAKE_GITHUB_OWNER;
  const repo = env.CODEXWAKE_GITHUB_REPO;
  if (!/^[A-Za-z0-9-]+$/.test(owner ?? "") || !/^[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
    throw new Error("Set CODEXWAKE_GITHUB_OWNER and CODEXWAKE_GITHUB_REPO to the private execution repository");
  }
  const userHome = options.userHome ?? homedir();
  const root = join(userHome, ".codexwake");
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Unsafe local state directory");
  const adminToken = env.CODEXWAKE_ADMIN_TOKEN || await readFile(join(root, "admin-token"), "utf8");
  const admin = (options.createAdmin ?? createAdminCoordinator)({ baseUrl: await configuredWorker(root, env), adminToken });
  const status = await admin.status();
  if (status.phase !== "WAITING" || status.config?.autoEnabled !== false || status.credentialUpdatePending !== false || status.credentialBootstrap) {
    return { outcome: "blocked", reason: "disable_and_wait_for_idle" };
  }
  const token = env.CODEXWAKE_SECRETS_TOKEN || await (options.getGitHubToken ?? localGitHubToken)(userHome);
  await (options.assertPrivateRepository ?? assertPrivateRepository)(owner, repo, token);
  const codexPath = env.CODEXWAKE_CODEX_PATH || resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/codex");
  if (!isAbsolute(codexPath)) throw new Error("Codex path must be absolute");
  const cliVersion = await (options.getVersion ?? localCliVersion)(codexPath);
  const codexHome = await mkdtemp(join(root, "login-"));
  // The newly created directory belongs only to this invocation. It is kept
  // if login, shutdown, or the Secret update is unconfirmed.
  await (options.login ?? runLogin)(codexPath, codexHome);
  const observed = await (options.observe ?? observeLocal)(codexPath, codexHome);
  const models = Array.isArray(observed?.models) ? observed.models.filter((model) => model && typeof model.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id)).map(({ id }) => ({ id })) : [];
  if (models.length === 0 || models.length > 500) return { outcome: "blocked", reason: "model_catalog_unavailable", localLoginDirectory: codexHome };
  const selected = env.CODEXWAKE_MODEL || status.config.model;
  if (!selected || !models.some((model) => model.id === selected)) {
    return { outcome: "blocked", reason: "model_unavailable", availableModels: models.map(({ id }) => id), localLoginDirectory: codexHome };
  }
  const authText = await (options.readAuth ?? readLocalAuthFile)(join(codexHome, "auth.json"));
  const result = await (options.register ?? registerLocalAccount)({ admin, authText, models, cliVersion, requestedModel: selected,
    resume: env.CODEXWAKE_RESUME === "yes", githubConfig: { owner, repo, secretName: "CODEX_AUTH_BUNDLE", token } });
  if (result.outcome !== "updated") return { ...result, localLoginDirectory: codexHome };
  await rm(codexHome, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await reauthenticateFromEnvironment(process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.outcome !== "updated") process.exitCode = 1;
  } catch {
    process.stderr.write("Reauthentication stopped. Check the operation guide; credentials were not printed.\n");
    process.exitCode = 1;
  }
}
