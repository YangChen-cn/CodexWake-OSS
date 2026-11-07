import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReadOnlyCodex } from "./app-server.mjs";
import { accountTag, ACTIVITY_MAX_AGE_MS, validateActivity } from "./activity-policy.mjs";
import { parseAuthFile } from "./credential-bundle.mjs";
import { readLocalAuthFile } from "./local-auth.mjs";
import { extractFiveHourSnapshot } from "./quota.mjs";
import { readBoundedJson } from "./http-utils.mjs";

export const localRoot = join(homedir(), ".codexwake");
export const localCodex = fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url));
export async function configuredWorker(root = localRoot, env = process.env) {
  const value = env.CODEXWAKE_ADMIN_URL || (await privateText(join(root, "worker-url"))).trim();
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Invalid Worker origin");
  }
  return url.origin;
}

export async function privateDir(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error("Unsafe private directory");
}

export async function privateText(path, max = 8192) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > max) throw new Error("Unsafe local file");
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > max) throw new Error("Local file too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

export async function writePrivateJson(path, value) {
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function monitorStatus(root = localRoot) {
  const paused = await lstat(join(root, "monitor-paused")).then(() => true, () => false);
  let last = null;
  try { last = JSON.parse(await privateText(join(root, "monitor-status.json"))); }
  catch { /* Unknown until a successful local observation. */ }
  let lastActivityAtMs = null;
  try { lastActivityAtMs = JSON.parse(await privateText(join(root, "last-local-activity.json"))); }
  catch { /* No correlated user turn yet. */ }
  return { paused, last, lastActivityAtMs };
}

export async function setMonitorPaused(paused, root = localRoot) {
  await privateDir(root);
  const file = join(root, "monitor-paused");
  if (paused) await writeFile(file, "", { mode: 0o600, flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  else await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
}

export function inspectLocalLimits(limits, observedAtMs) {
  const snapshot = extractFiveHourSnapshot(limits, { limitId: "codex", observedAtMs });
  const bucket = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
  const weeks = [bucket.primary, bucket.secondary].filter((window) => window?.windowDurationMins === 10080);
  const week = weeks[0];
  if (weeks.length !== 1 || !Number.isFinite(week.usedPercent) || week.usedPercent < 0 || week.usedPercent >= 100 ||
      !Number.isSafeInteger(week.resetsAt) || !Number.isSafeInteger(week.resetsAt * 1000) || week.resetsAt * 1000 <= observedAtMs ||
      bucket.spendControlReached !== false || bucket.credits?.hasCredits !== false || bucket.credits?.unlimited !== false ||
      typeof bucket.credits?.balance !== "string" || !/^0(?:\.0+)?$/.test(bucket.credits.balance)) throw new Error("Weekly allowance, spend control or credits are uncertain");
  // A full five-hour bucket can still be armed if the snapshot proves the
  // weekly bucket is available and no paid credits are in use.
  const ordinary = limits.ordinaryUsageAllowed === true && bucket.rateLimitReachedType == null;
  const fiveHourOnly = snapshot.usedPercent === 100 && limits.ordinaryUsageAllowed === false &&
    bucket.rateLimitReachedType === "rate_limit_reached";
  if (!ordinary && !fiveHourOnly) {
    throw new Error("Ordinary quota is unavailable");
  }
  return { ...snapshot, weekResetAtMs: week.resetsAt * 1000 };
}

async function observe(root, codexPath) {
  const codexHome = join(root, "observer");
  await privateDir(codexHome);
  const path = join(codexHome, "auth.json");
  const tag = await accountTag(parseAuthFile(await readLocalAuthFile(path)));
  const client = startReadOnlyCodex({ codexPath, codexHome, cwd: root, timeoutMs: 4500 });
  let limits;
  try {
    await client.initialize();
    const { account } = await client.request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") throw new Error("Observer requires ChatGPT login");
    limits = await client.request("account/rateLimits/read", { excludeResetCreditDetails: true });
  } finally { await client.closeAndWait(3000); }
  if (tag !== await accountTag(parseAuthFile(await readLocalAuthFile(path)))) throw new Error("Observer account changed");
  return { ...inspectLocalLimits(limits, Date.now()), accountTag: tag };
}

function workerEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Invalid Worker origin");
  }
  return new URL("/v1/local/activity", url);
}

async function report(event, root, worker) {
  const token = (await privateText(join(root, "activity-token"))).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Reporter token unavailable");
  const endpoint = workerEndpoint(worker);
  for (let attempt = 0; attempt < 2; attempt++) {
    validateActivity(event, Date.now());
    let response;
    try {
      response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3500),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event) });
    } catch {
      if (attempt === 0) continue;
      throw new Error("Activity delivery unconfirmed");
    }
    if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Activity report rejected"); }
    return readBoundedJson(response, 2048);
  }
}

export async function runLocalObservation({ activity, root = localRoot, codexPath = localCodex,
  worker } = {}, options = {}) {
  await privateDir(root);
  const lockPath = join(root, "observer.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") return null;
    throw error;
  });
  if (!lock) return { outcome: "observer_busy" };
  try {
    const { paused, last } = await monitorStatus(root);
    if (activity && paused) return { outcome: "monitor_paused" };
    const now = Date.now();
    if (activity && last?.activityChecked === true && last.observedAtMs > now - 60000 && (!last.resetAtMs || last.resetAtMs > now + 1000)) {
      return { outcome: "recent_observation" };
    }
    const { accountTag: tag, source, ...snapshot } = await (options.observe ?? observe)(root, codexPath);
    const priorReport = last?.reported === true && last.resetAtMs === snapshot.resetAtMs;
    const status = { ...snapshot, outcome: "read_only", reported: priorReport, activityChecked: Boolean(activity) };
    if (activity) {
      if (priorReport) status.outcome = "window_already_reported";
      else if (!(await monitorStatus(root)).paused) {
        const event = { ...snapshot, accountTag: tag, activityAtMs: activity.at,
          eventId: activity.id, eventKind: "user_activity", version: 1, windowKey: `codex:300:${snapshot.resetAtMs}` };
        try {
          validateActivity(event, Date.now());
          const result = await (options.report ?? report)(event, root, worker ?? await configuredWorker(root));
          status.outcome = result.outcome;
          status.reported = ["armed", "window_already_recorded", "reset_changed"].includes(result.outcome);
        } catch { status.outcome = "report_unconfirmed"; }
      }
    }
    await writePrivateJson(join(root, "monitor-status.json"), status);
    return status;
  } catch {
    await writePrivateJson(join(root, "monitor-status.json"), { outcome: "quota_unavailable", observedAtMs: Date.now(), activityChecked: Boolean(activity) });
    return { outcome: "quota_unavailable" };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function handleActivityHook(input, options = {}) {
  const root = options.root ?? localRoot;
  const env = options.env ?? process.env;
  if (env.CI || env.CODEXWAKE_AUTOMATIC || !input ||
      typeof input.turn_id !== "string" || !input.turn_id || input.turn_id.length > 200 ||
      typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 200 ||
      !["UserPromptSubmit", "PostModelRequest"].includes(input.hook_event_name)) return;
  await privateDir(root);
  if ((await monitorStatus(root)).paused) return;
  const id = createHash("sha256").update(JSON.stringify([input.session_id, input.turn_id])).digest("hex");
  const dir = join(root, "activity-markers");
  await privateDir(dir);
  const file = join(dir, id);
  const now = Date.now();
  if (input.hook_event_name === "UserPromptSubmit") {
    // Only correlation metadata is written. Prompt and transcript are ignored.
    const entries = await readdir(dir);
    let active = 0;
    for (const name of entries) {
      if (!/^[a-f0-9]{64}(?:\.used)?$/.test(name)) continue;
      const path = join(dir, name);
      if ((await lstat(path).catch(() => null))?.mtimeMs < now - ACTIVITY_MAX_AGE_MS) await unlink(path).catch(() => {});
      else active++;
    }
    if (active >= 256) return;
    await writeFile(file, String(now), { mode: 0o600, flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    return;
  }
  if (input.status !== "completed" || input.agent_id != null) return;
  let started;
  try {
    started = Number(await privateText(file, 32));
    if (!Number.isSafeInteger(started) || started > now || now - started > ACTIVITY_MAX_AGE_MS) return;
    // Keep the claim for the marker lifetime, including duplicate submit hooks.
    await writeFile(file + ".used", "", { mode: 0o600, flag: "wx" });
  } catch { return; }
  await writePrivateJson(join(root, "last-local-activity.json"), now);
  return (options.run ?? runLocalObservation)({ activity: { id, at: started }, root });
}

export function explicitActivity() {
  return { id: createHash("sha256").update(randomUUID()).digest("hex"), at: Date.now() };
}
