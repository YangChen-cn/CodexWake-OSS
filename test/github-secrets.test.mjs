import test from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers";
import { prepareSecretWrite, writeSecret } from "../src/github-secrets.mjs";

await sodium.ready;
const pair = sodium.crypto_box_keypair();
const config = { owner: "owner", repo: "private-repo", secretName: "CODEX_AUTH_BUNDLE", token: "synthetic-github-token" };
const bundle = '{"synthetic":"secret"}';

test("encrypts with GitHub public key in sealed-box format", async () => {
  const payload = await prepareSecretWrite(config, bundle, { fetch: async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/owner/private-repo/actions/secrets/public-key");
    assert.equal(init.headers.Authorization, "Bearer synthetic-github-token");
    return Response.json({ key_id: "key-1", key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL) });
  } });
  const encrypted = sodium.from_base64(payload.encrypted_value, sodium.base64_variants.ORIGINAL);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(encrypted, pair.publicKey, pair.privateKey)), bundle);
  assert.equal(payload.key_id, "key-1");
});

test("secret update makes one request and classifies ambiguous outcomes", async () => {
  const payload = { key_id: "key-1", encrypted_value: "YQ==" };
  let calls = 0;
  const configWithFetch = async (_url, init) => { calls++; assert.deepEqual(JSON.parse(init.body), payload); return new Response(null, { status: 204 }); };
  assert.deepEqual(await writeSecret(config, payload, { fetch: configWithFetch }), { outcome: "confirmed" });
  assert.equal(calls, 1);
  assert.equal((await writeSecret(config, payload, { fetch: async () => { throw new Error("synthetic timeout"); } })).outcome, "unknown");
  assert.equal((await writeSecret(config, payload, { fetch: async () => new Response(null, { status: 403 }) })).outcome, "rejected");
});

test("invalid public keys and secret names fail before updating", async () => {
  await assert.rejects(prepareSecretWrite(config, bundle, { fetch: async () => Response.json({ key_id: "k", key: "YQ==" }) }), /encrypt/);
  await assert.rejects(writeSecret({ ...config, secretName: "GITHUB_BAD" }, { key_id: "k", encrypted_value: "YQ==" }), /Invalid/);
});
