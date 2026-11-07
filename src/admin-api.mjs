import { readJsonBody } from "./http-utils.mjs";
import { validateConfig } from "./policy.mjs";

const encoder = new TextEncoder();
const response = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

// Compare through WebCrypto HMAC verification rather than JS string equality.
export async function verifyToken(candidate, secret, purpose = "codexwake-admin-token-v1") {
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const candidateKey = await crypto.subtle.importKey("raw", encoder.encode(candidate), algorithm, false, ["sign"]);
  const secretKey = await crypto.subtle.importKey("raw", encoder.encode(secret), algorithm, false, ["verify"]);
  const message = encoder.encode(purpose);
  const signature = await crypto.subtle.sign("HMAC", candidateKey, message);
  return crypto.subtle.verify("HMAC", secretKey, signature, message);
}

export async function handleAdminRequest(request, env) {
  const path = new URL(request.url).pathname;
  const isStatus = request.method === "GET" && path === "/v1/admin/status";
  const isAppointments = request.method === "PUT" && path === "/v1/admin/appointments";
  const isConfig = request.method === "PUT" && path === "/v1/admin/config";
  const isBootstrapPrepare = request.method === "POST" && path === "/v1/admin/bootstrap/prepare";
  const isBootstrapWrite = request.method === "POST" && path === "/v1/admin/bootstrap/authorize-write";
  const isBootstrapCommit = request.method === "POST" && path === "/v1/admin/bootstrap/commit";
  const isManualProbe = request.method === "POST" && path === "/v1/admin/probe";
  const isEnroll = request.method === "POST" && path === "/v1/admin/conservative/enroll";
  const isModelCatalog = request.method === "POST" && path === "/v1/admin/model-catalog";
  const isManualWake = request.method === "POST" && path === "/v1/admin/wake";
  const isManualTest = request.method === "POST" && path === "/v1/admin/test-now";
  const isReleaseRejectedTest = request.method === "POST" && path === "/v1/admin/release-rejected-test";
  const isCancel = request.method === "POST" && path === "/v1/admin/cancel-wake";
  const isRecover = request.method === "POST" && path === "/v1/admin/recover";
  if (!isStatus && !isConfig && !isAppointments && !isBootstrapPrepare && !isBootstrapWrite && !isBootstrapCommit && !isManualProbe && !isEnroll && !isModelCatalog && !isManualWake && !isManualTest && !isReleaseRejectedTest && !isCancel && !isRecover) return new Response("Not found", { status: 404 });
  if (typeof env.ADMIN_TOKEN !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(env.ADMIN_TOKEN)) {
    return response({ error: "admin API not configured" }, 503);
  }
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(request.headers.get("authorization") ?? "");
  if (!match || !await verifyToken(match[1], env.ADMIN_TOKEN)) return response({ error: "unauthorized" }, 401);
  if (isManualProbe && env.PROBE_DISPATCH_ENABLED !== "true") return response({ error: "manual probe dispatch is disabled" }, 503);
  if ((isEnroll || isModelCatalog || isManualWake || isManualTest) && env.ACTIVATION_ENABLED !== "true") return response({ error: "activation is disabled" }, 503);
  let payload = null;
  if (isAppointments) {
    try {
      const body = await readJsonBody(request, 8192);
      if (!body || Object.keys(body).sort().join(",") !== "appointments,expectedRevision" ||
          !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || !Array.isArray(body.appointments)) {
        throw new Error("Invalid appointments");
      }
      payload = body;
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isConfig) {
    try {
      const body = await readJsonBody(request, 8192);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "config,expectedRevision" ||
          !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Invalid configuration");
      payload = { config: validateConfig(body.config), expectedRevision: body.expectedRevision };
      // Until the complete runner and recovery flow has passed verification,
      // do not let operators mistake a configured scaffold for a live service.
      if (payload.config.autoEnabled && env.ACTIVATION_ENABLED !== "true") return response({ error: "automatic activation is not available yet" }, 409);
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isBootstrapPrepare || isBootstrapWrite || isBootstrapCommit) {
    try {
      const body = await readJsonBody(request);
      const keys = isBootstrapPrepare ? "digest,expectedRevision,generation" : "digest,generation";
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== keys ||
          typeof body.generation !== "string" || typeof body.digest !== "string" ||
          (isBootstrapPrepare && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0))) throw new Error("Invalid bootstrap");
      payload = body;
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isManualProbe || isManualWake || isManualTest || isCancel) {
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "expectedRevision" ||
          !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Invalid revision");
      payload = { expectedRevision: body.expectedRevision };
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isReleaseRejectedTest) {
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "attemptId,expectedRevision" ||
          typeof body.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.attemptId) ||
          !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Invalid release");
      payload = body;
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isEnroll || isModelCatalog) {
    try {
      const body = await readJsonBody(request, isModelCatalog ? 65536 : 4096);
      if (!body || typeof body !== "object" || Array.isArray(body) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Invalid revision");
      if (isEnroll) {
        if (Object.keys(body).sort().join(",") !== "acknowledged,expectedRevision" || body.acknowledged !== true) throw new Error("Acknowledgement required");
        payload = body;
      } else {
        if (Object.keys(body).sort().join(",") !== "cliVersion,expectedRevision,models" || typeof body.cliVersion !== "string" ||
            !/^\d+\.\d+\.\d+$/.test(body.cliVersion) || !Array.isArray(body.models) || body.models.length > 500 ||
            body.models.some((model) => !model || typeof model !== "object" || Array.isArray(model) || Object.keys(model).join(",") !== "id" ||
              typeof model.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id))) throw new Error("Invalid model catalog");
        payload = body;
      }
    } catch { return response({ error: "invalid request" }, 400); }
  }
  if (isRecover) {
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "confirmed,expectedRevision" ||
          body.confirmed !== true || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Invalid recovery");
      payload = body;
    } catch { return response({ error: "invalid request" }, 400); }
  }
  try {
    const id = env.COORDINATOR.idFromName("primary");
    const target = isStatus ? "/status" : isConfig ? "/config" : isAppointments ? "/appointments" : isManualProbe ? "/manual-probe" : isManualWake ? "/manual-wake" : isManualTest ? "/manual-test" : isCancel ? "/cancel-wake" : isReleaseRejectedTest ? "/release-rejected-test" : isRecover ? "/recover" : isEnroll ? "/conservative/enroll" : isModelCatalog ? "/model-catalog" : isBootstrapPrepare ? "/bootstrap/prepare" : isBootstrapWrite ? "/bootstrap/authorize-write" : "/bootstrap/commit";
    const init = isStatus ? { method: "GET" } : { method: isConfig || isAppointments ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    const upstream = await env.COORDINATOR.get(id).fetch(`https://coordinator.invalid${target}`, init);
    if (!upstream.ok) return response({ error: "configuration update rejected" }, upstream.status === 409 ? 409 : 503);
    return response(await upstream.json());
  } catch { return response({ error: "coordinator unavailable" }, 503); }
}
