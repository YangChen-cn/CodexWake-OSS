import { dashboardStatus, dashboardConfig } from "./dashboard-contract.mjs";
import { readJsonBody } from "./http-utils.mjs";
import { validateAppointments } from "./wake-planning.mjs";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const json = (body, status = 200) => Response.json(body, { status, headers });
const writes = new Map([
  ["/api/config", "PUT"],
  ["/api/appointments", "PUT"],
  ["/api/pause", "POST"],
  ["/api/resume", "POST"],
  ["/api/cancel", "POST"],
]);

async function sessionToken(request, env, ctx) {
  if (!env.DASHBOARD_ACCESS_AUD || !env.DASHBOARD_ALLOWED_EMAIL ||
      !ctx?.access || ctx.access.aud !== env.DASHBOARD_ACCESS_AUD) return null;
  const email = (await ctx.access.getIdentity())?.email;
  if (typeof email !== "string" || email.toLowerCase() !== env.DASHBOARD_ALLOWED_EMAIL.trim().toLowerCase()) return null;
  const cookie = /(?:^|;\s*)CF_Authorization=([A-Za-z0-9._-]{30,8192})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const assertion = request.headers.get("cf-access-jwt-assertion");
  const session = cookie ?? (/^[A-Za-z0-9._-]{30,8192}$/.test(assertion ?? "") ? assertion : null);
  if (!session) return null;
  const data = new TextEncoder().encode("codexwake-remote-csrf-v1:" + session);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function remoteDashboard(request, env, ctx, assets) {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.host !== env.DASHBOARD_HOST) return json({ error: "access_required" }, 403);
  let csrf;
  try { csrf = await sessionToken(request, env, ctx); }
  catch { return json({ error: "access_required" }, 403); }
  if (!csrf) return json({ error: "access_required" }, 403);
  const path = url.pathname;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Access may redirect the browser back from a different site after login.
  // Allow a top-level page load while keeping the JSON routes same-origin.
  const documentLoad = request.method === "GET" && path === "/" &&
    request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-dest") === "document";
  if ((origin && origin !== url.origin) || (!documentLoad && (site === "cross-site" || site === "same-site"))) {
    return json({ error: "local_origin_required" }, 403);
  }
  if (request.method === "GET" && Object.hasOwn(assets, path)) {
    const [content, type] = assets[path];
    const body = path === "/" ? content.replace("%%CSRF%%", csrf).replace("%%EXIT_VISIBILITY%%", "hidden")
      .replaceAll("%%LOCAL_VISIBILITY%%", "hidden").replace('data-mode="local"', 'data-mode="remote"') : content;
    return new Response(body, { headers: { ...headers, "content-type": type } });
  }
  if (request.method === "GET" && path === "/api/csrf") return json({ csrf });
  const read = request.method === "GET" && path === "/api/status";
  if (!read && writes.get(path) !== request.method) return json({ error: "not_found" }, 404);
  let input;
  if (!read) {
    if (origin !== url.origin || site !== "same-origin" || request.headers.get("x-codexwake-csrf") !== csrf ||
        request.headers.get("content-type") !== "application/json") return json({ error: "csrf_rejected" }, 403);
    try {
      input = await readJsonBody(request, 8192);
      const fields = path === "/api/config" ? "revision,settings" : path === "/api/appointments" ? "appointments,revision" : "revision";
      if (!input || Object.keys(input).sort().join(",") !== fields || !Number.isSafeInteger(input.revision)) throw new Error("Invalid input");
    } catch { return json({ error: "invalid_request" }, 400); }
  }

  try {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("primary"));
    const call = (route, method, body) => stub.fetch("https://coordinator.invalid" + route, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const upstream = await call("/status", "GET");
    if (!upstream.ok) return json({ error: "cloud_unavailable" }, 503);
    const current = dashboardStatus(await upstream.json());
    if (read) return json({ cloud: current, local: null });
    if (current.revision !== input.revision) return json({ error: "revision_conflict" }, 409);

    const expectedRevision = input.revision;
    let saved;
    if (path === "/api/cancel") saved = await call("/cancel-wake", "POST", { expectedRevision });
    else if (path === "/api/appointments") {
      let appointments;
      try { appointments = validateAppointments(input.appointments, Date.now()); }
      catch { return json({ error: "invalid_appointments" }, 400); }
      saved = await call("/appointments", "PUT", { appointments, expectedRevision });
    } else {
      let config;
      try {
        config = path === "/api/config" ? dashboardConfig(input.settings, current.config)
          : { ...current.config, autoEnabled: path === "/api/resume" };
      } catch { return json({ error: "invalid_config" }, 400); }
      if (config.model !== current.config.model && config.model !== current.verifiedModel) return json({ error: "invalid_config" }, 400);
      if (config.autoEnabled && current.automaticBlockReason) return json({ error: "activation_unavailable" }, 409);
      saved = await call("/config", "PUT", { config, expectedRevision });
    }
    if (!saved.ok) return json({ error: saved.status === 409 ? "revision_conflict" : "request_unconfirmed" }, saved.status === 409 ? 409 : 503);
    const result = await saved.json();
    return json({ revision: result.revision, permitAlreadyIssued: result.permitAlreadyIssued ?? current.phase === "ACTIVATING" });
  } catch { return json({ error: "request_unconfirmed" }, 503); }
}
