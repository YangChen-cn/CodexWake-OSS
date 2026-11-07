import { parseCredentialBundle, prepareCredentialUpdate } from "./credential-bundle.mjs";
import { prepareSecretWrite, writeSecret } from "./github-secrets.mjs";
import { retryIdempotent } from "./bounded-retry.mjs";

// Runner-side orchestration. The coordinator object must authenticate every
// request with this run's OIDC token. Inputs and the encrypted payload must
// never be logged. No automatic retry or release occurs on ambiguity.
export async function persistRefreshedCredential({ originalBundle, updatedAuth, nextGeneration, attemptId,
  githubConfig, coordinator }, options = {}) {
  const original = parseCredentialBundle(originalBundle);
  const update = prepareCredentialUpdate(originalBundle, updatedAuth, nextGeneration);
  if (!update.changed) return { outcome: "unchanged", generation: original.generation };
  try {
    await retryIdempotent(() => coordinator.prepare({ attemptId, from: original.generation, to: nextGeneration }), options.retryOptions);
  } catch {
    return { outcome: "pending", reason: "reservation_unconfirmed" };
  }
  let payload;
  try { payload = await (options.prepareSecretWrite ?? prepareSecretWrite)(githubConfig, update.bundle, options.githubOptions); }
  catch { return { outcome: "pending", reason: "encryption_unavailable" }; }
  try { await coordinator.authorizeWrite({ attemptId, to: nextGeneration }); }
  catch { return { outcome: "pending", reason: "write_authorization_unconfirmed" }; }
  let write;
  try { write = await (options.writeSecret ?? writeSecret)(githubConfig, payload, options.githubOptions); }
  catch { return { outcome: "pending", reason: "write_unconfirmed" }; }
  if (write?.outcome !== "confirmed") return { outcome: "pending", reason: "write_unconfirmed" };
  try { await retryIdempotent(() => coordinator.commit({ attemptId, to: nextGeneration }), options.retryOptions); }
  catch { return { outcome: "pending", reason: "commit_unconfirmed" }; }
  return { outcome: "updated", generation: nextGeneration };
}
