// Runner-side OIDC acquisition and coordinator client. Credentials must stay
// in memory and must not be inherited by the Codex child process.
import { readBoundedJson } from "./http-utils.mjs";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function boundedTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw new Error("Invalid request timeout");
  return value;
}

// The job-provided URL must be used verbatim except for the audience. GitHub
// cloud's job endpoint is restricted to actions.githubusercontent.com; fail
// closed if GitHub changes it or a self-hosted enterprise uses another host.
export function createGitHubOidcProvider({ requestUrl, requestToken, audience }, options = {}) {
  let url;
  try { url = new URL(requestUrl); } catch { throw new Error("Invalid GitHub OIDC request URL"); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com") ||
      url.username || url.password || url.port || url.hash ||
      typeof requestToken !== "string" || !requestToken || requestToken.length > 16384 ||
      typeof audience !== "string" || !audience || audience.length > 512) {
    throw new Error("Invalid GitHub OIDC configuration");
  }
  url.searchParams.set("audience", audience);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 10000);
  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetch ?? fetch)(url.toString(), {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${requestToken}` },
      });
      if (response.status !== 200) throw new Error("OIDC request rejected");
      const result = await readBoundedJson(response);
      if (typeof result?.value !== "string" || result.value.length > 16384 || !JWT.test(result.value)) {
        throw new Error("Invalid OIDC response");
      }
      return result.value;
    } catch { throw new Error("GitHub OIDC token unavailable"); }
    finally { clearTimeout(timeout); }
  };
}

export function createRunnerCoordinator({ baseUrl, getOidcToken }, options = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error("Invalid coordinator URL"); }
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.search || base.hash ||
      base.pathname !== "/" || typeof getOidcToken !== "function") throw new Error("Invalid coordinator configuration");
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 10000);

  async function call(path, body, responseKind = "ordinary") {
    let token;
    try { token = await getOidcToken(); } catch { throw new Error("Runner identity unavailable"); }
    if (typeof token !== "string" || token.length > 16384 || !JWT.test(token)) throw new Error("Invalid runner identity");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetch ?? fetch)(new URL(path, base).toString(), {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status !== 200) throw new Error("Coordinator rejected request");
      const result = await readBoundedJson(response);
      if (result?.ok !== true || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("Invalid coordinator response");
      if (responseKind === "activation") {
        if (typeof result.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(result.model) ||
            typeof result.message !== "string" || !result.message.trim() || result.message.length > 1000) throw new Error("Invalid activation permission");
        return { revision: result.revision, model: result.model, message: result.message };
      }
      const kind = responseKind === "claim" && ["automatic", "manual_probe", "estimated_activation", "manual_test", "activity_wake"].includes(result.kind) ? { kind: result.kind } : {};
      return { revision: result.revision, ...kind };
    } catch { throw new Error("Coordinator request unconfirmed"); }
    finally { clearTimeout(timeout); }
  }
  return {
    claim: ({ attemptId, credentialGeneration }) => call("/v1/runner/claim", { attemptId, credentialGeneration }, "claim"),
    prepare: ({ attemptId, from, to }) => call("/v1/runner/credential/prepare", { attemptId, from, to }),
    authorizeWrite: ({ attemptId, to }) => call("/v1/runner/credential/authorize-write", { attemptId, to }),
    commit: ({ attemptId, to }) => call("/v1/runner/credential/commit", { attemptId, to }),
    complete: ({ attemptId, snapshot }) => call("/v1/runner/probe/complete", { attemptId, snapshot }),
    // Callers must never retry this one-shot authorization on ambiguity.
    authorizeActivation: ({ attemptId, models, cliVersion, accountTag }) =>
      call("/v1/runner/activation/authorize", { attemptId, models, cliVersion, ...(accountTag ? { accountTag } : {}) }, "activation"),
    skipActivation: ({ attemptId }) => call("/v1/runner/activation/skip", { attemptId }),
    completeActivation: ({ attemptId, outcome, startedAtMs, finishedAtMs, beforeSnapshot, afterSnapshot }) =>
      call("/v1/runner/activation/complete", { attemptId, outcome, startedAtMs, finishedAtMs, beforeSnapshot, afterSnapshot }),
  };
}
