import { createHash, randomUUID } from "node:crypto";
import { makeCredentialBundle } from "./credential-bundle.mjs";
import { prepareSecretWrite, writeSecret } from "./github-secrets.mjs";
import { retryIdempotent } from "./bounded-retry.mjs";

// Local operator flow. The admin client must authenticate every request.
// Only generation and digest are sent to the Worker; the OAuth bundle goes
// exclusively to GitHub after LibSodium encryption.
export async function bootstrapCredential({ authText, generation = randomUUID(), expectedRevision, admin, githubConfig }, options = {}) {
  const bundle = makeCredentialBundle(authText, generation);
  const digest = createHash("sha256").update(bundle, "utf8").digest("hex");
  const metadata = { generation, digest };
  try { await retryIdempotent(() => admin.prepareBootstrap({ ...metadata, expectedRevision }), options.retryOptions); }
  catch { return { outcome: "pending", reason: "reservation_unconfirmed", ...metadata }; }
  let payload;
  try { payload = await (options.prepareSecretWrite ?? prepareSecretWrite)(githubConfig, bundle, options.githubOptions); }
  catch { return { outcome: "pending", reason: "encryption_unavailable", ...metadata }; }
  try { await admin.authorizeBootstrapWrite(metadata); }
  catch { return { outcome: "pending", reason: "write_authorization_unconfirmed", ...metadata }; }
  let written;
  try { written = await (options.writeSecret ?? writeSecret)(githubConfig, payload, options.githubOptions); }
  catch { return { outcome: "pending", reason: "write_unconfirmed", ...metadata }; }
  if (written?.outcome !== "confirmed") return { outcome: "pending", reason: "write_unconfirmed", ...metadata };
  try { await retryIdempotent(() => admin.commitBootstrap(metadata), options.retryOptions); }
  catch { return { outcome: "pending", reason: "commit_unconfirmed", ...metadata }; }
  return { outcome: "updated", ...metadata };
}
