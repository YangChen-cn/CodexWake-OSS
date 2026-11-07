import assets from "../.wrangler/generated/dashboard-assets.mjs";
import { remoteDashboard } from "./remote-dashboard.mjs";

export default {
  fetch(request, env, ctx) {
    return remoteDashboard(request, env, ctx, assets);
  },
};
