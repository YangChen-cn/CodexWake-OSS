import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import sodium from "libsodium-wrappers";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { bootstrapCredential } from "../src/bootstrap-credential.mjs";

test("bootstrap binds a synthetic encrypted bundle to the real SQLite coordinator", async () => {
  await sodium.ready;
  const paths = ["worker", "coordinator", "activity-api", "activity-policy", "wake-planning", "runner-api", "admin-api", "github-oidc", "github-dispatch", "dispatch-orchestrator", "http-utils", "policy", "state", "eligibility", "conservative-window", "model-selection", "notify", "recovery", "status-mirror"];
  const modules = paths.map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(`../src/${path}.mjs`, import.meta.url)) }));
  const adminToken = "a".repeat(43);
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, modulesRoot: fileURLToPath(new URL("..", import.meta.url)),
    compatibilityDate: "2026-10-01", bindings: { ADMIN_TOKEN: adminToken },
    durableObjects: { COORDINATOR: { className: "Coordinator", useSQLite: true } } }));
  const admin = createAdminCoordinator({ baseUrl: "https://worker.example", adminToken },
    { fetch: (url, init) => mf.dispatchFetch(url, init) });
  const githubConfig = { owner: "owner", repo: "repo", secretName: "CODEX_AUTH_BUNDLE", token: "synthetic-github" };
  const pair = sodium.crypto_box_keypair();
  const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
  const authText = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } });
  let writes = 0;
  let failWrite = true;
  const githubOptions = { fetch: async (_url, init) => {
    if (init.method === "GET") return Response.json({ key_id: "test", key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL) });
    writes++;
    if (failWrite) throw new Error("synthetic lost response");
    return new Response(null, { status: 204 });
  } };
  try {
    const args = { authText, generation, expectedRevision: 0, admin, githubConfig };
    const first = await bootstrapCredential(args, { githubOptions });
    assert.equal(first.outcome, "pending");
    assert.equal(first.reason, "write_unconfirmed");
    assert.equal((await admin.status()).credentialBootstrap.digest, first.digest);
    const altered = await bootstrapCredential({ ...args, authText: authText.replace("synthetic-refresh", "different-refresh") }, { githubOptions });
    assert.equal(altered.reason, "reservation_unconfirmed");
    failWrite = false;
    const recovered = await bootstrapCredential(args, { githubOptions });
    assert.equal(recovered.reason, "write_authorization_unconfirmed");
    assert.equal(writes, 1);
    const status = await admin.status();
    assert.equal(status.credentialGeneration, null);
    assert.equal(status.credentialBootstrap.writeState, "writing");
    assert.equal(status.config.autoEnabled, false);
  } finally { await mf.dispose(); }
});
