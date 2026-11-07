import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseCredentialBundle } from "./credential-bundle.mjs";
import { startReadOnlyCodex, readOnlyProbe } from "./app-server.mjs";
import { persistRefreshedCredential } from "./persist-credential.mjs";
import { extractFiveHourSnapshot } from "./quota.mjs";
import { retryIdempotent } from "./bounded-retry.mjs";

// Probe only: never sends a model message. The coordinator and GitHub client
// live in this parent process; the Codex child receives neither credential.
// A pending result retains the private directory so the live Runner can try
// recovery; callers must not print its contents or upload it as an artifact.
export async function runProbeAttempt({ attemptId, originalBundle, codexPath, coordinator, githubConfig,
  limitId, tempRoot = tmpdir() }, options = {}) {
  if (typeof attemptId !== "string" || !attemptId || typeof limitId !== "string" || !limitId ||
      typeof tempRoot !== "string" || !isAbsolute(tempRoot) || typeof codexPath !== "string" || !isAbsolute(codexPath)) {
    throw new Error("Invalid probe configuration");
  }
  const bundle = parseCredentialBundle(originalBundle);
  try { await retryIdempotent(() => coordinator.claim({ attemptId, credentialGeneration: bundle.generation }), options.retryOptions); }
  catch { return { outcome: "blocked", reason: "claim_unconfirmed" }; }

  let root;
  try {
    root = await mkdtemp(join(tempRoot, "codexwake-"));
    await mkdir(join(root, "codex"), { mode: 0o700 });
    await mkdir(join(root, "work"), { mode: 0o700 });
    await writeFile(join(root, "codex", "auth.json"), JSON.stringify(bundle.auth), { mode: 0o600, flag: "wx" });
  } catch {
    // No Codex process has started, so the input credential cannot have
    // refreshed. Remove only the private directory created by this call.
    if (root) await rm(root, { recursive: true, force: true });
    return { outcome: "blocked", reason: "temporary_storage_unavailable" };
  }

  let client;
  let result;
  let probeFailed = false;
  try {
    client = (options.startCodex ?? startReadOnlyCodex)({ codexPath, codexHome: join(root, "codex"), cwd: join(root, "work") });
    const observed = await (options.probe ?? readOnlyProbe)(client);
    const nowMs = (options.now ?? Date.now)();
    const snapshot = extractFiveHourSnapshot(observed.limits, { limitId, observedAtMs: nowMs });
    result = { outcome: "probe_complete", planType: observed.planType, models: observed.models, snapshot };
  } catch { probeFailed = true; }

  if (client) {
    try { await client.closeAndWait(); }
    catch { return { outcome: "pending", reason: "shutdown_unconfirmed", recoveryDirectory: root }; }
  }
  let updatedAuth;
  try { updatedAuth = await readFile(join(root, "codex", "auth.json"), "utf8"); }
  catch { return { outcome: "pending", reason: "credential_file_unavailable", recoveryDirectory: root }; }

  let persistence;
  try {
    persistence = await (options.persist ?? persistRefreshedCredential)({ originalBundle, updatedAuth,
      nextGeneration: (options.newGeneration ?? randomUUID)(), attemptId, githubConfig, coordinator });
  } catch { return { outcome: "pending", reason: "credential_persistence_unconfirmed", recoveryDirectory: root }; }
  if (!persistence || !["updated", "unchanged"].includes(persistence.outcome)) {
    return { outcome: "pending", reason: "credential_persistence_unconfirmed", recoveryDirectory: root };
  }
  let reportConfirmed = false;
  if (!probeFailed) {
    try { await retryIdempotent(() => coordinator.complete({ attemptId, snapshot: result.snapshot }), options.retryOptions); reportConfirmed = true; }
    catch { /* The coordinator keeps the attempt reserved until reconciled. */ }
  }
  try { await rm(root, { recursive: true, force: true }); }
  catch { return { outcome: "pending", reason: "cleanup_unconfirmed", recoveryDirectory: root }; }
  if (probeFailed) return { outcome: "failed", reason: "quota_probe_failed", credential: persistence.outcome };
  if (!reportConfirmed) return { outcome: "pending", reason: "report_unconfirmed", snapshot: result.snapshot };
  return { ...result, credential: persistence.outcome };
}
