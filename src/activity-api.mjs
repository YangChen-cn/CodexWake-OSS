import { validateActivity } from "./activity-policy.mjs";
import { readJsonBody } from "./http-utils.mjs";
import { verifyToken } from "./admin-api.mjs";

const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function handleActivityRequest(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = env.ACTIVITY_REPORT_TOKEN;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret ?? "") || secret === env.ADMIN_TOKEN) return json({ error: "reporter unavailable" }, 503);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match || !await verifyToken(match[1], secret, "codexwake-activity-token-v1")) return json({ error: "unauthorized" }, 401);
  let event;
  try { event = validateActivity(await readJsonBody(request, 2048), Date.now()); }
  catch { return json({ error: "invalid or stale activity" }, 400); }
  try {
    const id = env.COORDINATOR.idFromName("primary");
    const result = await env.COORDINATOR.get(id).fetch("https://coordinator.invalid/local-activity", {
      method: "POST", body: JSON.stringify(event),
    });
    if (!result.ok) return json({ error: "activity rejected" }, 409);
    return json(await result.json());
  } catch { return json({ error: "coordinator unavailable" }, 503); }
}
