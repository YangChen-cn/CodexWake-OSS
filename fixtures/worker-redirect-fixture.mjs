// Local integration fixture only: all outbound requests target a test server.
import { dispatchWorkflow } from "../src/github-dispatch.mjs";
import { verifyGitHubOidc } from "../src/github-oidc.mjs";
import { sendSuccessNotification } from "../src/notify.mjs";
import { verifyCompletedGitHubRun } from "../src/recovery.mjs";

export default {
  async fetch(_request, env) {
    const redirect = (_url, init) => fetch(`${env.TEST_SERVER}/redirect`, init);
    const githubConfig = { owner: "owner", repo: "repo", workflow: "wake.yml", ref: "refs/heads/main", token: "synthetic" };
    const dispatched = await dispatchWorkflow({ ...githubConfig, attemptId: "d5482ec8-8db6-4ea0-87b6-a21b0ee813b6" }, { fetch: redirect });
    const notified = await sendSuccessNotification({ url: "https://notify.example/hook", finishedAtMs: 42 }, { fetch: redirect });
    const recovered = await verifyCompletedGitHubRun({ githubConfig, runId: "123", repositoryId: "456", workflowSha: "a".repeat(40) }, { fetch: redirect });
    const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const token = `${encode({ alg: "RS256", kid: "test" })}.${encode({})}.AA`;
    let jwksRejected = false;
    try { await verifyGitHubOidc(token, { audience: "a", repositoryId: "456", repositoryOwnerId: "789", workflowRef: "a", ref: "b", workflowSha: "a".repeat(40) }, { fetch: redirect }); }
    catch { jwksRejected = true; }
    return Response.json({ dispatch: dispatched.outcome, notification: notified.outcome, recovery: recovered, jwksRejected });
  },
};
