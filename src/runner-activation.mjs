import { accountTag } from "./activity-policy.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseCredentialBundle } from "./credential-bundle.mjs";
import { startReadOnlyCodex, readOnlyProbe } from "./app-server.mjs";
import { assessActivationQuota } from "./activation-quota.mjs";
import { extractFiveHourSnapshot } from "./quota.mjs";
import { persistRefreshedCredential } from "./persist-credential.mjs";
import { runActivationTurn } from "./activation-executor.mjs";
import { retryIdempotent } from "./bounded-retry.mjs";

// This orchestrates one activation only;
// neither a lost permit response nor an ambiguous model outcome is retried.
// Do not log returned private paths, auth data, model output or prompt text.
export async function runActivationAttempt({ attemptId, originalBundle, codexPath, coordinator, githubConfig,
  limitId, cliVersion, observationMode = "live", tempRoot = tmpdir() }, options = {}) {
  if (typeof attemptId !== "string" || !attemptId || typeof limitId !== "string" || !limitId ||
      !["live", "local_attested"].includes(observationMode) ||
      typeof cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(cliVersion) ||
      typeof tempRoot !== "string" || !isAbsolute(tempRoot) || typeof codexPath !== "string" || !isAbsolute(codexPath)) {
    throw new Error("Invalid activation configuration");
  }
  const bundle = parseCredentialBundle(originalBundle);
  let claim;
  try { claim = await retryIdempotent(() => coordinator.claim({ attemptId, credentialGeneration: bundle.generation }), options.retryOptions); }
  catch { return { outcome: "blocked", reason: "claim_unconfirmed" }; }

  let root;
  try {
    root = await mkdtemp(join(tempRoot, "codexwake-activation-"));
    await mkdir(join(root, "codex"), { mode: 0o700 });
    await mkdir(join(root, "work"), { mode: 0o700 });
    await writeFile(join(root, "codex", "auth.json"), JSON.stringify(bundle.auth), { mode: 0o600, flag: "wx" });
  } catch {
    if (root) await rm(root, { recursive: true, force: true });
    return { outcome: "blocked", reason: "temporary_storage_unavailable" };
  }

  // Every probe may refresh auth.json, including a failed probe. A process
  // whose shutdown is unconfirmed prevents both further execution and writes.
  async function observe() {
    let client;
    let observed;
    try {
      client = (options.startCodex ?? startReadOnlyCodex)({ codexPath, codexHome: join(root, "codex"), cwd: join(root, "work") });
      observed = await (options.probe ?? readOnlyProbe)(client);
    } catch { /* A failed observation is a veto, not proof of no refresh. */ }
    if (client) {
      try { await client.closeAndWait(); }
      catch { return { shutdownConfirmed: false }; }
    }
    return { shutdownConfirmed: true, observed };
  }

  // The fallback avoids hosted App Server auth. Its catalog was observed on
  // the user's local machine for the fixed CLI version. It has
  // NO live quota data, which must remain explicit in reports and status.
  const before = observationMode === "live" ? await observe() : { shutdownConfirmed: true, observed: { models: [] } };
  if (!before.shutdownConfirmed) return { outcome: "pending", reason: "shutdown_unconfirmed", recoveryDirectory: root };
  const beforeMs = (options.now ?? Date.now)();
  const assessment = observationMode === "local_attested" ? { allowed: true, reason: "quota_unavailable_estimate_only" }
    : before.observed ? assessActivationQuota(before.observed.limits, { limitId, observedAtMs: beforeMs })
      : { allowed: false, reason: "quota_probe_failed" };
  let permit;
  let blockedReason = assessment.allowed ? null : assessment.reason;
  if (assessment.allowed) {
    // This operation is deliberately not retried, even for the same run.
    const models = Array.isArray(before.observed.models) ? before.observed.models
      .filter((model) => model && typeof model.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id))
      .map(({ id }) => ({ id })) : [];
    try {
      const tag = claim?.kind === "activity_wake" ? await accountTag(bundle.auth) : undefined;
      permit = await coordinator.authorizeActivation({ attemptId, models, cliVersion, ...(tag ? { accountTag: tag } : {}) });
    }
    catch { blockedReason = "permit_unconfirmed"; }
  }
  let turn;
  let afterSnapshot = null;
  if (permit) {
    try {
      turn = await (options.execute ?? runActivationTurn)({ codexPath, codexHome: join(root, "codex"), cwd: join(root, "work"),
        model: permit.model, message: permit.message });
    } catch { return { outcome: "pending", reason: "shutdown_unconfirmed", recoveryDirectory: root }; }
    if (!turn || turn.outcome === "shutdown_unconfirmed" ||
        !["completed_unverified", "unconfirmed", "not_started"].includes(turn.outcome)) {
      return { outcome: "pending", reason: "shutdown_unconfirmed", recoveryDirectory: root };
    }
    if (turn.outcome === "completed_unverified" && observationMode === "live") {
      const after = await observe();
      if (!after.shutdownConfirmed) return { outcome: "pending", reason: "shutdown_unconfirmed", recoveryDirectory: root };
      try { afterSnapshot = extractFiveHourSnapshot(after.observed?.limits, { limitId, observedAtMs: (options.now ?? Date.now)() }); }
      catch { /* Success remains unverified; do not invent a quota snapshot. */ }
    }
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
  let reportConfirmed = true;
  if (turn) {
    try { await retryIdempotent(() => coordinator.completeActivation({ attemptId, outcome: turn.outcome,
      startedAtMs: turn.startedAtMs, finishedAtMs: turn.finishedAtMs,
      beforeSnapshot: assessment.snapshot ?? null, afterSnapshot }), options.retryOptions); }
    catch { reportConfirmed = false; }
  }
  if (!turn && claim?.kind === "activity_wake") {
    try { await retryIdempotent(() => coordinator.skipActivation({ attemptId }), options.retryOptions); }
    catch { reportConfirmed = false; }
  }
  try { await rm(root, { recursive: true, force: true }); }
  catch { return { outcome: "pending", reason: "cleanup_unconfirmed", recoveryDirectory: root }; }
  if (!reportConfirmed) return { outcome: "pending", reason: "report_unconfirmed" };
  if (!turn) return { outcome: "blocked", reason: blockedReason ?? "permit_unconfirmed", credential: persistence.outcome };
  return { outcome: turn.outcome, credential: persistence.outcome,
    ...(typeof turn.reason === "string" ? { reason: turn.reason } : {}),
    ...(typeof turn.responseReceived === "boolean" ? { responseReceived: turn.responseReceived } : {}) };
}
