import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dashboardConfig, dashboardStatus } from "./dashboard-contract.mjs";
import { validateAppointments } from "./wake-planning.mjs";
import { describeMonitor, configureMonitor } from "./monitor-install.mjs";
import { runLocalObservation } from "./local-activity.mjs";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/ui.css": ["ui.css", "text/css; charset=utf-8"],
  "/ui.js": ["ui.js", "text/javascript; charset=utf-8"],
};

export async function startDashboard({ admin, port = 0, fd, idleMs = 10 * 60 * 1000, monitor = describeMonitor,
  controlMonitor = configureMonitor, observe = runLocalObservation } = {}) {
  const csrf = randomBytes(32).toString("base64url");
  const managed = fd !== undefined || idleMs === null;
  let origin;
  let idle;
  function resetIdleTimeout() {
    if (idleMs === null) return;
    clearTimeout(idle);
    idle = setTimeout(() => server.close(), idleMs);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site" || req.headers["sec-fetch-site"] === "same-site") {
      return json(403, { error: "local_origin_required" });
    }
    resetIdleTimeout();
    try {
      const path = req.url;
      if (req.method === "GET" && Object.hasOwn(assets, path)) {
        const [file, type] = assets[path];
        const content = await readFile(new URL("../dashboard/" + file, import.meta.url), "utf8");
        const body = path === "/"
          ? content.replace("%%CSRF%%", csrf).replaceAll("%%LOCAL_VISIBILITY%%", "").replace("%%EXIT_VISIBILITY%%", managed ? "hidden" : "")
          : content;
        return res.writeHead(200, { "Content-Type": type }).end(body);
      }
      if (req.method === "GET" && path === "/api/csrf") return json(200, { csrf });
      if (req.method === "GET" && path === "/api/status") {
        const local = await monitor();
        try {
          const cloud = await admin.status();
          return json(200, { local, cloud: dashboardStatus(cloud) });
        } catch { return json(200, { local, cloud: null, error: "cloud_unavailable" }); }
      }
      if (req.method !== "POST" || !["/api/config", "/api/appointments", "/api/control", "/api/monitor", "/api/quota", "/api/exit"].includes(path)) {
        return json(404, { error: "not_found" });
      }
      if (req.headers.origin !== origin || req.headers["x-codexwake-csrf"] !== csrf ||
          req.headers["content-type"] !== "application/json") return json(403, { error: "csrf_rejected" });
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8192) return json(413, { error: "body_too_large" });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return json(400, { error: "invalid_request" }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "invalid_request" });
      if (path === "/api/exit") {
        if (managed) return json(409, { error: "dashboard_managed" });
        json(200, { closed: true });
        server.close();
        return;
      }
      if (path === "/api/quota") return json(200, await observe());
      if (path === "/api/monitor") {
        if (!["start", "stop", "install", "uninstall"].includes(input.action)) return json(400, { error: "invalid_action" });
        return json(200, await controlMonitor(input.action));
      }
      const current = await admin.status();
      if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) {
        return json(409, { error: "revision_conflict" });
      }
      if (path === "/api/control" && input.action === "cancel") {
        return json(200, await admin.cancelWake({ expectedRevision: input.revision }));
      }
      if (path === "/api/appointments") {
        let appointments;
        try { appointments = validateAppointments(input.appointments, Date.now()); }
        catch { return json(400, { error: "invalid_appointments" }); }
        return json(200, await admin.setAppointments({ appointments, expectedRevision: input.revision }));
      }
      let config;
      if (path === "/api/config") {
        try { config = dashboardConfig(input.settings, current.config); }
        catch { return json(400, { error: "invalid_config" }); }
      } else {
        if (!["pause", "resume"].includes(input.action)) return json(400, { error: "invalid_action" });
        config = { ...current.config, autoEnabled: input.action === "resume" };
      }
      if (config.autoEnabled && current.automaticBlockReason) return json(409, { error: "activation_unavailable" });
      return json(200, await admin.setConfig({ config, expectedRevision: input.revision }));
    } catch (error) {
      if (res.headersSent) return res.end();
      return json(error?.cause === "conflict" ? 409 : 503, { error: error?.cause === "conflict" ? "revision_conflict" : "request_unconfirmed" });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.on("close", () => clearTimeout(idle));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fd === undefined ? { port, host: "127.0.0.1" } : { fd }, resolve);
  });
  const address = server.address();
  if (address.address !== "127.0.0.1") {
    server.close();
    throw new Error("Dashboard requires an IPv4 loopback socket");
  }
  origin = `http://127.0.0.1:${address.port}`;
  resetIdleTimeout();
  return { server, origin };
}
