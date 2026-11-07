import { readBoundedJson } from "./http-utils.mjs";
import { validateConfig } from "./policy.mjs";

// Local client only; never place ADMIN_TOKEN in a URL, log, repository, or
// Codex child environment. The caller supplies the trusted Worker origin.
export function createAdminCoordinator({ baseUrl, adminToken }, options = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error("Invalid coordinator URL"); }
  if (base.protocol !== "https:" || base.username || base.password || base.port || base.search || base.hash || base.pathname !== "/" ||
      typeof adminToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) throw new Error("Invalid administrator configuration");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid request timeout");
  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let conflict = false;
    try {
      const response = await (options.fetch ?? fetch)(new URL(path, base).toString(), {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      conflict = response.status === 409;
      if (response.status !== 200) throw new Error("Administrator request rejected");
      const result = await readBoundedJson(response);
      if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("Invalid administrator response");
      return result;
    } catch { throw new Error("Administrator request unconfirmed", conflict ? { cause: "conflict" } : undefined); }
    finally { clearTimeout(timeout); }
  }
  return {
    status: () => call("/v1/admin/status"),
    setConfig: ({ config, expectedRevision }) => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid expected revision");
      return call("/v1/admin/config", { config: validateConfig(config), expectedRevision }, "PUT");
    },
    prepareBootstrap: ({ generation, digest, expectedRevision }) => call("/v1/admin/bootstrap/prepare", { generation, digest, expectedRevision }),
    authorizeBootstrapWrite: ({ generation, digest }) => call("/v1/admin/bootstrap/authorize-write", { generation, digest }),
    commitBootstrap: ({ generation, digest }) => call("/v1/admin/bootstrap/commit", { generation, digest }),
    startProbe: ({ expectedRevision }) => call("/v1/admin/probe", { expectedRevision }),
    enrollConservative: ({ expectedRevision }) => call("/v1/admin/conservative/enroll", { acknowledged: true, expectedRevision }),
    attestModels: ({ expectedRevision, cliVersion, models }) => call("/v1/admin/model-catalog", { expectedRevision, cliVersion, models }),
    setAppointments: (payload) => call("/v1/admin/appointments", payload, "PUT"),
    cancelWake: ({ expectedRevision }) => call("/v1/admin/cancel-wake", { expectedRevision }),
    startWake: ({ expectedRevision }) => call("/v1/admin/wake", { expectedRevision }),
    startManualTest: ({ expectedRevision }) => call("/v1/admin/test-now", { expectedRevision }),
    releaseRejectedManualTest: ({ attemptId, expectedRevision }) => call("/v1/admin/release-rejected-test", { attemptId, expectedRevision }),
    recover: ({ expectedRevision }) => call("/v1/admin/recover", { confirmed: true, expectedRevision }),
  };
}
