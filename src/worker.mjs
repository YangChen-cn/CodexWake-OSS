export { Coordinator } from "./coordinator.mjs";
import { handleRunnerRequest } from "./runner-api.mjs";
import { handleAdminRequest } from "./admin-api.mjs";

import { handleActivityRequest } from "./activity-api.mjs";

export default {
  async scheduled(_controller, env) {
    const id = env.COORDINATOR.idFromName("primary");
    const response = await env.COORDINATOR.get(id).fetch("https://coordinator.invalid/tick", {
      method: "POST",
    });
    if (!response.ok) throw new Error(`Coordinator tick failed: ${response.status}`);
  },

  // Admin and Runner routes each enforce their own authentication.
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/v1/local/activity") return handleActivityRequest(request, env);
    if (new URL(request.url).pathname.startsWith("/v1/admin/")) return handleAdminRequest(request, env);
    return handleRunnerRequest(request, env);
  },
};
