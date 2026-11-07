import test from "node:test";
import assert from "node:assert/strict";
import { dispatchWorkflow } from "../src/github-dispatch.mjs";

const config = { owner: "owner", repo: "private-repo", workflow: "wake.yml", ref: "refs/heads/main",
  token: "test-token", attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6" };

test("dispatches once with correlation ID and returns run ID", async () => {
  let calls = 0;
  const result = await dispatchWorkflow(config, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/owner/private-repo/actions/workflows/wake.yml/dispatches");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.headers["User-Agent"], "CodexWake/1.0");
    assert.deepEqual(JSON.parse(init.body), { ref: config.ref, inputs: { attempt_id: config.attemptId } });
    return Response.json({ workflow_run_id: 123 });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { outcome: "accepted", runId: "123" });
});

test("ambiguous errors never trigger an automatic second dispatch", async () => {
  for (const fetcher of [async () => { throw new Error("timeout"); },
    async () => new Response("error", { status: 500 }),
    async () => new Response(null, { status: 204 }), async () => new Response(null, { status: 302, headers: { location: "https://untrusted.example/" } }),
    async () => Response.json({ no_id: true })]) {
    let calls = 0;
    const result = await dispatchWorkflow(config, { fetch: async (...args) => { calls++; return fetcher(...args); } });
    assert.equal(result.outcome, "unknown");
    assert.equal(calls, 1);
  }
});

test("rejected and invalid requests are handled without leaking tokens", async () => {
  const result = await dispatchWorkflow(config, { fetch: async () => new Response("", { status: 403 }) });
  assert.deepEqual(result, { outcome: "rejected", status: 403 });
  await assert.rejects(dispatchWorkflow({ ...config, repo: "../other" }, { fetch: async () => { throw new Error("unexpected"); } }), /Invalid/);
});

test("the timeout remains active while reading the response body", async () => {
  const result = await dispatchWorkflow(config, { timeoutMs: 10, fetch: async (_url, init) => ({
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }) });
  assert.equal(result.outcome, "unknown");
});
