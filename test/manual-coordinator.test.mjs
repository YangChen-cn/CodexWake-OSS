import test from "node:test";
import assert from "node:assert/strict";
import { Coordinator } from "../src/coordinator.mjs";
import { initialState } from "../src/state.mjs";

function storageFake() {
  let value = { ...initialState(), credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd" };
  return { get: async () => structuredClone(value), transaction: async (callback) => {
    let pending = structuredClone(value);
    const result = await callback({ get: async () => structuredClone(pending), put: async (_key, next) => { pending = structuredClone(next); } });
    value = pending; return result;
  } };
}
const env = { PROBE_DISPATCH_ENABLED: "true", GITHUB_DISPATCH_OWNER: "owner", GITHUB_DISPATCH_REPO: "repo",
  GITHUB_OIDC_REF: "refs/heads/main", GITHUB_ACTIONS_WRITE_TOKEN: "synthetic-actions-token",
  GITHUB_OIDC_WORKFLOW_REF: "owner/repo/.github/workflows/probe.yml@refs/heads/main", GITHUB_OIDC_REPOSITORY_ID: "123",
  GITHUB_OIDC_OWNER_ID: "456", GITHUB_OIDC_WORKFLOW_SHA: "a".repeat(40), GITHUB_OIDC_AUDIENCE: "codexwake" };
const request = () => new Request("https://internal/manual-probe", { method: "POST", body: JSON.stringify({ expectedRevision: 0 }) });

test("manual coordinator dispatch requires complete settings and reserves exactly once", async () => {
  let calls = 0;
  const storage = storageFake();
  const disabled = new Coordinator({ storage }, { ...env, PROBE_DISPATCH_ENABLED: "false" }, { dispatch: async () => { calls++; } });
  assert.equal((await disabled.fetch(request())).status, 503);
  const invalid = new Coordinator({ storage }, { ...env, GITHUB_OIDC_WORKFLOW_REF: "wrong" }, { dispatch: async () => { calls++; } });
  assert.equal((await invalid.fetch(request())).status, 503);
  assert.equal(calls, 0);
  const coordinator = new Coordinator({ storage }, env, { dispatch: async (config) => {
    calls++; assert.equal(config.workflow, "probe.yml"); return { outcome: "accepted", runId: "101" };
  } });
  const response = await coordinator.fetch(request());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.outcome, "accepted");
  assert.equal(result.revision, 2);
  assert.equal((await coordinator.fetch(request())).status, 409);
  assert.equal(calls, 1);
});
