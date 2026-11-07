import test from "node:test";
import assert from "node:assert/strict";
import { sendSuccessNotification, validateSuccessWebhook } from "../src/notify.mjs";

test("success webhook sends only sanitized unverified status once", async () => {
  let calls = 0;
  const result = await sendSuccessNotification({ url: "https://notify.example/hook/private-token", finishedAtMs: 42 }, {
    fetch: async (_url, init) => { calls++; assert.equal(init.redirect, "manual");
      assert.deepEqual(JSON.parse(init.body), { event: "codexwake.activation_completed_unverified", finishedAtMs: 42, timingSource: "conservative_estimate" });
      return new Response(null, { status: 204 }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "sent");
});

test("notification errors are sanitized and unsafe destinations are refused", async () => {
  for (const url of ["http://notify.example", "https://user:pass@notify.example/", "https://127.0.0.1/", "https://localhost/"]) {
    assert.throws(() => validateSuccessWebhook(url));
  }
  const result = await sendSuccessNotification({ url: "https://notify.example/private", finishedAtMs: 42 }, { fetch: async () => { throw new Error("sensitive"); } });
  assert.deepEqual(result, { outcome: "unconfirmed" });
});
