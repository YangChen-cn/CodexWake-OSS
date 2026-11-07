import { readBoundedJson } from "./http-utils.mjs";
import { validateDispatchConfig } from "./github-dispatch.mjs";

// Read-only check: never trust a user-supplied claim that the run ended.
export async function verifyCompletedGitHubRun({ githubConfig, runId, repositoryId, workflowSha }, options = {}) {
  validateDispatchConfig(githubConfig);
  if (typeof runId !== "string" || !/^[1-9]\d*$/.test(runId) || typeof repositoryId !== "string" || !/^[1-9]\d*$/.test(repositoryId) ||
      typeof workflowSha !== "string" || !/^[a-f0-9]{40}$/i.test(workflowSha)) throw new Error("Invalid run verification");
  const url = `https://api.github.com/repos/${encodeURIComponent(githubConfig.owner)}/${encodeURIComponent(githubConfig.repo)}/actions/runs/${runId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await (options.fetch ?? fetch)(url, { method: "GET", redirect: "manual", signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${githubConfig.token}`, "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "CodexWake/1.0" } });
    if (response.status !== 200) return false;
    const run = await readBoundedJson(response, 65536);
    return String(run.id) === runId && run.status === "completed" && run.run_attempt === 1 && run.event === "workflow_dispatch" &&
      run.path === `.github/workflows/${githubConfig.workflow}` && run.head_sha === workflowSha && String(run.repository?.id) === repositoryId &&
      run.head_branch === githubConfig.ref.slice("refs/heads/".length);
  } catch { return false; }
  finally { clearTimeout(timeout); }
}
