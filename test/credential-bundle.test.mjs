import test from "node:test";
import assert from "node:assert/strict";
import { makeCredentialBundle, parseAuthFile, parseCredentialBundle, prepareCredentialUpdate } from "../src/credential-bundle.mjs";

const generation = "663c2fc3-5099-45f7-9e1f-280ee522eefd";
const nextGeneration = "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6";
const auth = { auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" }, last_refresh: "2026-11-04T00:00:00Z" };
const text = JSON.stringify(auth);

test("bundle round-trips ChatGPT auth and preserves additional fields", () => {
  assert.deepEqual(parseCredentialBundle(makeCredentialBundle(text, generation)).auth, auth);
});

test("rejects non-ChatGPT, API key, missing tokens, oversized and malformed inputs", () => {
  for (const value of ["{", JSON.stringify({ ...auth, auth_mode: "apikey" }),
    JSON.stringify({ ...auth, OPENAI_API_KEY: "key" }),
    JSON.stringify({ ...auth, tokens: { access_token: "x" } }), "x".repeat(49153)]) {
    assert.throws(() => parseAuthFile(value));
  }
});

test("only changed credentials need a new generation and bundle", () => {
  const original = makeCredentialBundle(text, generation);
  assert.deepEqual(prepareCredentialUpdate(original, text, nextGeneration), { changed: false });
  const changed = JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: "new-token" } });
  assert.throws(() => prepareCredentialUpdate(original, changed, generation));
  const update = prepareCredentialUpdate(original, changed, nextGeneration);
  assert.equal(update.changed, true);
  assert.equal(parseCredentialBundle(update.bundle).generation, nextGeneration);
});
