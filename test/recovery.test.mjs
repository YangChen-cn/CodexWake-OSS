import test from "node:test";
import assert from "node:assert/strict";
import { verifyCompletedGitHubRun } from "../src/recovery.mjs";

const config = { owner: "owner", repo: "repo", workflow: "wake.yml", ref: "refs/heads/main", token: "synthetic" };
const sha = "a".repeat(40);
const run = { id: 123, status: "completed", run_attempt: 1, event: "workflow_dispatch", path: ".github/workflows/wake.yml",
  head_sha: sha, repository: { id: 456 }, head_branch: "main" };
const check = (body) => verifyCompletedGitHubRun({ githubConfig: config, runId: "123", repositoryId: "456", workflowSha: sha },
  { fetch: async (_url, init) => { assert.equal(init.redirect, "manual"); assert.equal(init.headers["User-Agent"], "CodexWake/1.0"); return Response.json(body); } });

test("recovery accepts only the exact completed trusted workflow run", async () => {
  assert.equal(await check(run), true);
  for (const update of [{ status: "in_progress" }, { run_attempt: 2 }, { event: "push" }, { path: ".github/workflows/other.yml" },
    { head_sha: "b".repeat(40) }, { repository: { id: 999 } }, { head_branch: "other" }]) {
    assert.equal(await check({ ...run, ...update }), false);
  }
});
