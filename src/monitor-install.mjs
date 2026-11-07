import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorStatus, setMonitorPaused } from "./local-activity.mjs";

const events = ["UserPromptSubmit", "PostModelRequest"];
const hookScript = fileURLToPath(new URL("../scripts/activity.mjs", import.meta.url));
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const marker = " # codexwake-managed-v1";
const command = `${shellQuote(process.execPath)} ${shellQuote(hookScript)} hook${marker}`;
const defaultPath = join(homedir(), ".codex", "hooks.json");

async function readHooks(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 128 * 1024) {
    throw new Error("Unsafe Codex hooks file");
  }
  const json = JSON.parse(await readFile(path, "utf8"));
  if (!json || typeof json !== "object" || Array.isArray(json) ||
      (json.hooks !== undefined && (!json.hooks || typeof json.hooks !== "object" || Array.isArray(json.hooks))) ||
      events.some((event) => json.hooks?.[event] !== undefined && !Array.isArray(json.hooks[event]))) {
    throw new Error("Invalid Codex hooks file");
  }
  return json;
}

const owned = (hook) => typeof hook?.command === "string" && hook.command.endsWith(marker);

export async function describeMonitor({ path = defaultPath, root } = {}) {
  const status = await monitorStatus(root);
  try {
    const config = await readHooks(path);
    const installed = events.every((event) => (config.hooks?.[event] ?? []).some((group) => group.hooks?.some(owned)));
    return { ...status, installed, mode: "codex_hooks" };
  } catch { return { ...status, installed: null, mode: "codex_hooks" }; }
}

export async function configureMonitor(action, { path = defaultPath, root } = {}) {
  if (action === "stop" || action === "start") {
    await setMonitorPaused(action === "stop", root);
    return describeMonitor({ path, root });
  }
  if (!["install", "uninstall"].includes(action)) throw new Error("Invalid monitor action");
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error("Unsafe Codex hook directory");
  const lock = path + ".codexwake.lock";
  await writeFile(lock, "", { flag: "wx", mode: 0o600 });
  const temporary = path + "." + randomUUID();
  try {
    const config = await readHooks(path);
    config.hooks ??= {};
    for (const event of events) {
      const groups = [];
      for (const group of config.hooks[event] ?? []) {
        if (!Array.isArray(group?.hooks)) { groups.push(group); continue; }
        const hooks = group.hooks.filter((hook) => !owned(hook));
        if (hooks.length) groups.push({ ...group, hooks });
      }
      if (action === "install") groups.push({ hooks: [{ type: "command", command, timeout: event === "UserPromptSubmit" ? 3 : 30,
        ...(event === "PostModelRequest" ? { async: true } : {}) }] });
      if (groups.length) config.hooks[event] = groups;
      else delete config.hooks[event];
    }
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return describeMonitor({ path, root });
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(lock);
  }
}
