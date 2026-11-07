import { verifyGitHubOidc } from "./github-oidc.mjs";
import { readJsonBody } from "./http-utils.mjs";

function oidcConfiguration(env) {
  return { audience: env.GITHUB_OIDC_AUDIENCE, repositoryId: env.GITHUB_OIDC_REPOSITORY_ID,
    repositoryOwnerId: env.GITHUB_OIDC_OWNER_ID, workflowRef: env.GITHUB_OIDC_WORKFLOW_REF,
    ref: env.GITHUB_OIDC_REF, workflowSha: env.GITHUB_OIDC_WORKFLOW_SHA };
}

export async function handleRunnerRequest(request, env, options = {}) {
  const routes = {
    "/v1/runner/claim": { fields: "attemptId,credentialGeneration", target: "/claim" },
    "/v1/runner/credential/prepare": { fields: "attemptId,from,to", target: "/credential/prepare" },
    "/v1/runner/credential/authorize-write": { fields: "attemptId,to", target: "/credential/authorize-write" },
    "/v1/runner/credential/commit": { fields: "attemptId,to", target: "/credential/commit" },
    "/v1/runner/probe/complete": { fields: "attemptId,snapshot", target: "/probe/complete", snapshot: true },
    "/v1/runner/activation/authorize": { fields: "attemptId,cliVersion,models", target: "/activation/authorize", activation: "authorize" },
    "/v1/runner/activation/skip": { fields: "attemptId", target: "/activation/skip", activation: "skip" },
    "/v1/runner/activation/complete": { fields: "afterSnapshot,attemptId,beforeSnapshot,finishedAtMs,outcome,startedAtMs", target: "/activation/complete", activation: "complete" },
  };
  const route = routes[new URL(request.url).pathname];
  if (request.method !== "POST" || !route) {
    return new Response("Not found", { status: 404 });
  }
  if (route.activation && env.ACTIVATION_ENABLED !== "true") return Response.json({ error: "activation disabled" }, { status: 503 });
  const expected = oidcConfiguration(env);
  if (Object.values(expected).some((value) => typeof value !== "string" || !value)) {
    return Response.json({ error: "runner API not configured" }, { status: 503 });
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match || match[1].length > 16384) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body;
  try {
    body = await readJsonBody(request, route.activation === "authorize" ? 65536 : 4096);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== (route.activation === "authorize" && Object.hasOwn(body, "accountTag") ? "accountTag," + route.fields : route.fields) ||
        typeof body.attemptId !== "string") throw new Error("Invalid body");
    if (route.activation === "authorize") {
      if ((Object.hasOwn(body, "accountTag") && (typeof body.accountTag !== "string" || !/^[a-f0-9]{64}$/.test(body.accountTag))) || typeof body.cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(body.cliVersion) ||
          !Array.isArray(body.models) || body.models.length > 500 || body.models.some((model) => !model ||
          typeof model !== "object" || Array.isArray(model) || Object.keys(model).join(",") !== "id" ||
          typeof model.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id))) throw new Error("Invalid models");
    } else if (route.activation === "complete") {
      if (!["completed_unverified", "unconfirmed", "not_started"].includes(body.outcome) ||
          ![body.startedAtMs, body.finishedAtMs].every((value) => Number.isSafeInteger(value) && value >= 0) ||
          [body.beforeSnapshot, body.afterSnapshot].some((value) => value !== null && (typeof value !== "object" || Array.isArray(value)))) {
        throw new Error("Invalid activation report");
      }
    } else if (route.snapshot) {
      if (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) throw new Error("Invalid snapshot");
    } else if (Object.values(body).some((value) => typeof value !== "string")) throw new Error("Invalid body");
  } catch { return Response.json({ error: "invalid request" }, { status: 400 }); }
  let identity;
  try { identity = await (options.verify ?? verifyGitHubOidc)(match[1], expected); }
  catch { return Response.json({ error: "unauthorized" }, { status: 401 }); }
  try {
    const id = env.COORDINATOR.idFromName("primary");
    const response = await env.COORDINATOR.get(id).fetch(`https://coordinator.invalid${route.target}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, identity }),
    });
    if (!response.ok) return Response.json({ error: "claim rejected" }, { status: 409 });
    const result = await response.json();
    if (route.activation === "authorize") {
      if (!Number.isSafeInteger(result.revision) || typeof result.model !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(result.model) || typeof result.message !== "string" ||
          !result.message.trim() || result.message.length > 1000) throw new Error("Invalid activation permission");
      return Response.json({ ok: true, revision: result.revision, model: result.model, message: result.message });
    }
    const kind = route.target === "/claim" && ["automatic", "manual_probe", "estimated_activation", "manual_test", "activity_wake"].includes(result.kind) ? { kind: result.kind } : {};
    return Response.json({ ok: true, revision: result.revision, ...kind });
  } catch { return Response.json({ error: "coordinator unavailable" }, { status: 503 }); }
}
