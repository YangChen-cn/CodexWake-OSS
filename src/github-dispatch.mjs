const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const DEFINITIVE_REJECTIONS = new Set([400, 401, 403, 404, 422]);

// This adapter makes exactly one dispatch HTTP request. A network failure,
// malformed success, or server error may mean GitHub accepted the request;
// callers must reconcile or pause, never automatically dispatch again.
export function validateDispatchConfig({ owner, repo, workflow, ref, token }) {
  if (![owner, repo, workflow].every((value) => typeof value === "string" && SAFE_NAME.test(value) && value !== "." && value !== "..") ||
      typeof ref !== "string" || !/^refs\/heads\/[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.includes("..") ||
      typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid workflow dispatch configuration");
  }
}

export async function dispatchWorkflow({ owner, repo, workflow, ref, token, attemptId }, options = {}) {
  validateDispatchConfig({ owner, repo, workflow, ref, token });
  if (typeof attemptId !== "string" || !UUID.test(attemptId)) throw new Error("Invalid workflow dispatch configuration");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid dispatch timeout");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "CodexWake/1.0" },
      // API version 2026-03-10 returns the run ID without an extra body flag.
      body: JSON.stringify({ ref, inputs: { attempt_id: attemptId } }),
    });
    if (DEFINITIVE_REJECTIONS.has(response.status)) return { outcome: "rejected", status: response.status };
    if (response.status !== 200) return { outcome: "unknown", reason: "unexpected_status", status: response.status };
    try {
      const result = await response.json();
      if (!Number.isSafeInteger(result.workflow_run_id) || result.workflow_run_id < 1) throw new Error("Invalid run ID");
      return { outcome: "accepted", runId: String(result.workflow_run_id) };
    } catch {
      return { outcome: "unknown", reason: "invalid_response" };
    }
  } catch {
    return { outcome: "unknown", reason: "transport_error" };
  } finally {
    clearTimeout(timeout);
  }
}
