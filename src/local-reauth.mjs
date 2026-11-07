import { randomUUID } from "node:crypto";
import { bootstrapCredential } from "./bootstrap-credential.mjs";
import { selectModel } from "./model-selection.mjs";

// The caller has just created and probed an isolated local login. Nothing in
// this module logs authText or either token. A pending Secret write stops the
// sequence immediately and is never retried automatically.
export async function registerLocalAccount({ admin, authText, models, cliVersion, githubConfig, requestedModel = null, resume = false }, options = {}) {
  if (!Array.isArray(models) || models.length > 500 || typeof cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(cliVersion) ||
      typeof resume !== "boolean") throw new Error("Invalid local registration input");
  let status = await admin.status();
  if (status.phase !== "WAITING" || status.config?.autoEnabled !== false || status.credentialUpdatePending !== false || status.credentialBootstrap) {
    return { outcome: "blocked", reason: "coordinator_not_idle" };
  }
  const model = requestedModel ?? status.config.model;
  if (typeof model !== "string" || selectModel({ models, selectedModel: model, nowMs: (options.now ?? Date.now)() }).outcome !== "selected") {
    return { outcome: "blocked", reason: "model_unavailable" };
  }
  if (model !== status.config.model) {
    await admin.setConfig({ config: { ...status.config, model }, expectedRevision: status.revision });
    status = await admin.status();
  }
  const generation = (options.newGeneration ?? randomUUID)();
  const bootstrap = await (options.bootstrap ?? bootstrapCredential)({ authText, generation, expectedRevision: status.revision, admin, githubConfig }, options.bootstrapOptions);
  if (bootstrap?.outcome !== "updated") return { outcome: "pending", reason: "credential_bootstrap_unconfirmed" };
  status = await admin.status();
  if (status.phase !== "WAITING" || status.config?.autoEnabled !== false || status.credentialGeneration !== generation || status.config.model !== model) {
    return { outcome: "blocked", reason: "state_changed_after_bootstrap" };
  }
  await admin.attestModels({ expectedRevision: status.revision, cliVersion, models: models.map(({ id }) => ({ id })) });
  status = await admin.status();
  await admin.enrollConservative({ expectedRevision: status.revision });
  status = await admin.status();
  if (resume) {
    await admin.setConfig({ config: { ...status.config, autoEnabled: true }, expectedRevision: status.revision });
    status = await admin.status();
  }
  return { outcome: "updated", enabled: status.config.autoEnabled, model, notBeforeMs: status.conservativeEstimate?.notBeforeMs ?? null };
}
