// The URL may itself contain a webhook secret. Never log it or response data.
export function validateSuccessWebhook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid success webhook"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !/^(?=.{1,253}$)(?![0-9.]+$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname) ||
      url.hostname.endsWith(".local")) throw new Error("Invalid success webhook");
  return url.toString();
}

export async function sendSuccessNotification({ url, finishedAtMs }, options = {}) {
  const destination = validateSuccessWebhook(url);
  if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0) throw new Error("Invalid notification time");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await (options.fetch ?? fetch)(destination, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "codexwake.activation_completed_unverified",
        finishedAtMs, timingSource: "conservative_estimate" }) });
    return { outcome: response.ok ? "sent" : "unconfirmed" };
  } catch { return { outcome: "unconfirmed" }; }
  finally { clearTimeout(timeout); }
}
