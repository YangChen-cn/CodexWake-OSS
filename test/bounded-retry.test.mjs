import test from "node:test";
import assert from "node:assert/strict";
import { retryIdempotent } from "../src/bounded-retry.mjs";

test("idempotent calls are retried only up to the configured bound", async () => {
  let calls = 0;
  const value = await retryIdempotent(async () => { calls++; if (calls < 3) throw new Error("temporary"); return "ok"; }, { delayMs: 0 });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryIdempotent(async () => { calls++; throw new Error("secret text"); }, { maxAttempts: 2, delayMs: 0 }),
    (error) => error.message === "Idempotent operation unconfirmed");
  assert.equal(calls, 2);
});
