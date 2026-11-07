import sodium from "libsodium-wrappers";

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function secretUrl({ owner, repo, secretName, token }) {
  if (![owner, repo].every((value) => typeof value === "string" && SAFE_NAME.test(value) && value !== "." && value !== "..") ||
      typeof secretName !== "string" || !SECRET_NAME.test(secretName) || /^GITHUB_/i.test(secretName) ||
      typeof token !== "string" || !token.trim()) throw new Error("Invalid GitHub Secret configuration");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`;
}

function headers(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" };
}

function timeoutController(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid GitHub Secret timeout");
  const controller = new AbortController();
  return { controller, timeout: setTimeout(() => controller.abort(), timeoutMs) };
}

// Only call after an authenticated coordinator has reserved an update. Never
// log the plaintext bundle or returned payload; neither is an audit record.
export async function prepareSecretWrite(config, bundleText, options = {}) {
  const root = secretUrl(config);
  if (typeof bundleText !== "string" || new TextEncoder().encode(bundleText).length > 48 * 1024) {
    throw new Error("Invalid secret data size");
  }
  const { controller, timeout } = timeoutController(options.timeoutMs ?? 10000);
  let keyInfo;
  try {
    const response = await (options.fetch ?? fetch)(`${root}/public-key`, { method: "GET", redirect: "error",
      signal: controller.signal, headers: headers(config.token) });
    if (response.status !== 200) throw new Error("Public key unavailable");
    keyInfo = await response.json();
  } catch {
    throw new Error("GitHub Secret public key could not be obtained");
  } finally { clearTimeout(timeout); }
  if (typeof keyInfo?.key_id !== "string" || !keyInfo.key_id || keyInfo.key_id.length > 256 ||
      typeof keyInfo.key !== "string" || !BASE64.test(keyInfo.key)) throw new Error("Invalid GitHub Secret public key");
  await sodium.ready;
  let encryptedValue;
  try {
    const publicKey = sodium.from_base64(keyInfo.key, sodium.base64_variants.ORIGINAL);
    if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) throw new Error("Invalid public key size");
    const encrypted = sodium.crypto_box_seal(sodium.from_string(bundleText), publicKey);
    encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  } catch { throw new Error("Failed to encrypt GitHub Secret"); }
  return { key_id: keyInfo.key_id, encrypted_value: encryptedValue };
}

// A PUT that times out or returns a server error is ambiguous. Never retry it
// automatically: the earlier request could arrive after a later refresh.
export async function writeSecret(config, payload, options = {}) {
  const root = secretUrl(config);
  if (!payload || typeof payload.key_id !== "string" || !payload.key_id || payload.key_id.length > 256 ||
      typeof payload.encrypted_value !== "string" || payload.encrypted_value.length > 70000 ||
      !BASE64.test(payload.encrypted_value)) throw new Error("Invalid encrypted GitHub Secret payload");
  const { controller, timeout } = timeoutController(options.timeoutMs ?? 10000);
  try {
    const response = await (options.fetch ?? fetch)(`${root}/${encodeURIComponent(config.secretName)}`, {
      method: "PUT", redirect: "error", signal: controller.signal, headers: headers(config.token), body: JSON.stringify(payload),
    });
    if (response.status === 201 || response.status === 204) return { outcome: "confirmed" };
    if ([400, 401, 403, 404, 422].includes(response.status)) return { outcome: "rejected", status: response.status };
    return { outcome: "unknown", status: response.status };
  } catch { return { outcome: "unknown", reason: "transport_error" }; }
  finally { clearTimeout(timeout); }
}
