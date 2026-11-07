// Use only for coordinator operations explicitly designed to be idempotent.
// Never use this helper for Secret PUT, write authorization, or model turns.
export async function retryIdempotent(action, { maxAttempts = 3, delayMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof action !== "function" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 ||
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60000 || typeof sleep !== "function") {
    throw new Error("Invalid retry configuration");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await action(); }
    catch { if (attempt + 1 < maxAttempts) await sleep(delayMs); }
  }
  throw new Error("Idempotent operation unconfirmed");
}
