// This module handles secrets in memory. Callers must never log inputs,
// returned bundles, exception causes, or include them in artifacts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SECRET_BYTES = 48 * 1024;
const encoder = new TextEncoder();

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text) {
  if (typeof text !== "string" || encoder.encode(text).length > MAX_SECRET_BYTES) {
    throw new Error("Invalid credential data size");
  }
  try { return JSON.parse(text); } catch { throw new Error("Invalid credential JSON"); }
}

function validateAuth(auth) {
  if (!object(auth) || auth.auth_mode !== "chatgpt" || !object(auth.tokens) ||
      typeof auth.tokens.access_token !== "string" || !auth.tokens.access_token.trim() ||
      typeof auth.tokens.refresh_token !== "string" || !auth.tokens.refresh_token.trim() ||
      (auth.OPENAI_API_KEY !== undefined && auth.OPENAI_API_KEY !== null)) {
    throw new Error("Expected ChatGPT managed OAuth credentials with a refresh token");
  }
  return auth;
}

export function parseAuthFile(text) {
  return validateAuth(parseJson(text));
}

export function parseCredentialBundle(text) {
  const bundle = parseJson(text);
  if (!object(bundle) || bundle.formatVersion !== 1 || typeof bundle.generation !== "string" ||
      !UUID.test(bundle.generation) || !object(bundle.auth)) {
    throw new Error("Invalid credential bundle");
  }
  validateAuth(bundle.auth);
  return bundle;
}

export function makeCredentialBundle(authText, generation) {
  if (typeof generation !== "string" || !UUID.test(generation)) throw new Error("Invalid credential generation");
  const bundle = { formatVersion: 1, generation, auth: parseAuthFile(authText) };
  const serialized = JSON.stringify(bundle);
  if (encoder.encode(serialized).length > MAX_SECRET_BYTES) throw new Error("Credential bundle exceeds GitHub Secret size limit");
  return serialized;
}

// Caller must reserve the new generation with the coordinator and publish the
// bundle using GitHub's public-key encryption. No I/O occurs here.
export function prepareCredentialUpdate(originalText, updatedAuthText, nextGeneration) {
  const original = parseCredentialBundle(originalText);
  const updated = parseAuthFile(updatedAuthText);
  if (JSON.stringify(original.auth) === JSON.stringify(updated)) return { changed: false };
  if (nextGeneration === original.generation) throw new Error("New credential generation must differ");
  return { changed: true, bundle: makeCredentialBundle(updatedAuthText, nextGeneration) };
}
