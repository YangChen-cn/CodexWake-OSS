import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { configuredWorker, localRoot, privateDir, privateText } from "../src/local-activity.mjs";

const exec = promisify(execFile);
const label = "com.codexwake.dashboard";
const marker = "<!-- Managed by CodexWake Dashboard -->";
const agents = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(agents, `${label}.plist`);
const helper = join(localRoot, "dashboard-socket");
const helperSource = fileURLToPath(new URL("./dashboard-socket.c", import.meta.url));
const dashboard = fileURLToPath(new URL("./dashboard.mjs", import.meta.url));
const launchctl = (args) => exec("/bin/launchctl", args, { timeout: 10000 });

async function readPlist() {
  const info = await lstat(plistPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 16384) {
    throw new Error("Unsafe existing LaunchAgent file.");
  }
  const plist = await readFile(plistPath, "utf8");
  if (!plist.includes(marker)) throw new Error("An unrelated file already uses the CodexWake LaunchAgent path.");
  return plist;
}

async function loadedJob(target) {
  try { return (await launchctl(["print", target])).stdout; }
  catch (error) {
    if (error.code === 113) return null;
    throw new Error("The macOS login session could not be inspected.");
  }
}

async function unloadJob(target) {
  try { await launchctl(["bootout", target]); }
  catch (error) {
    if (error.code !== 3 || await loadedJob(target)) throw error;
  }
}

async function writeAgent(plist) {
  const temporary = plistPath + "." + randomUUID();
  try {
    await writeFile(temporary, plist, { flag: "wx", mode: 0o600 });
    await rename(temporary, plistPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function stableNode() {
  const executable = await realpath(process.execPath);
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (await realpath(candidate).catch(() => null) === executable) return candidate;
  }
  return executable;
}

function renderPlist(node, port, worker) {
  const string = (value) => `<string>${String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${marker}
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>${[helper, node, dashboard, "--socket-activated"].map(string).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEXWAKE_DASHBOARD_PORT</key>${string(port)}
    <key>CODEXWAKE_ADMIN_URL</key>${string(worker)}
    <key>PATH</key>${string(`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}
  </dict>
  <key>Sockets</key>
  <dict><key>Dashboard</key><dict>
    <key>SockNodeName</key><string>127.0.0.1</string>
    <key>SockServiceName</key>${string(port)}
    <key>SockFamily</key><string>IPv4</string>
  </dict></dict>
</dict>
</plist>
`;
}

async function checkPort(port) {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(port, "127.0.0.1", resolve);
  }).catch((error) => {
    if (error.code === "EADDRINUSE") throw new Error(`Port ${port} is in use. Stop the temporary dashboard or choose another port.`);
    throw new Error(`Cannot listen on port ${port}.`);
  });
  await new Promise((resolve) => socket.close(resolve));
}

async function waitForDashboard(url) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(500) });
      const page = await response.text();
      if (response.ok && page.includes('name="codexwake-csrf"') && page.includes("<footer hidden>")) return;
    } catch { /* launchd may still be starting Node. */ }
    await delay(250);
  }
  throw new Error("The dashboard did not become reachable. Check macOS Login Items and project folder access.");
}

async function main(action) {
  if (process.platform !== "darwin") throw new Error("Dashboard LaunchAgent commands require macOS.");
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const previous = await readPlist();
  const job = await loadedJob(target);
  if (job && !previous) throw new Error("The label is already loaded outside this installer.");

  if (action === "status") {
    const port = previous?.match(/<key>CODEXWAKE_DASHBOARD_PORT<\/key><string>(\d+)<\/string>/)?.[1];
    const pid = Number(job?.match(/^\s*pid = (\d+)/m)?.[1]) || null;
    console.log(JSON.stringify({ installed: Boolean(previous), running: pid !== null, pid,
      mode: previous ? (previous.includes("<key>Sockets</key>") ? "on-demand" : "resident") : null,
      url: port ? `http://127.0.0.1:${port}` : null }, null, 2));
    return;
  }
  if (action === "uninstall") {
    if (job) await unloadJob(target);
    if (previous) await unlink(plistPath);
    console.log("Dashboard LaunchAgent removed.");
    return;
  }
  if (action !== "install") throw new Error("Expected install, status, or uninstall.");

  const port = Number(process.env.CODEXWAKE_DASHBOARD_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Dashboard port must be between 1 and 65535.");
  const worker = await configuredWorker();
  const adminToken = (await privateText(join(localRoot, "admin-token"))).trim();
  createAdminCoordinator({ baseUrl: worker, adminToken });
  const plist = renderPlist(await stableNode(), port, worker);
  const upgrading = previous !== null && !previous.includes("<key>Sockets</key>");
  if (previous && previous !== plist && !upgrading) throw new Error("Dashboard settings differ. Uninstall before installing with new settings.");
  const url = `http://127.0.0.1:${port}`;
  if (!job || upgrading) {
    if (!job) await checkPort(port);
    await privateDir(localRoot);
    const temporary = helper + "." + randomUUID();
    try {
      await exec("/usr/bin/clang", ["-Wall", "-Wextra", "-O2", helperSource, "-o", temporary], { timeout: 30000 });
      await rename(temporary, helper);
    } catch {
      throw new Error("Could not build the launchd socket helper. Check Xcode command line tools.");
    } finally {
      await unlink(temporary).catch(() => {});
    }

    await mkdir(agents, { recursive: true, mode: 0o755 });
    const info = await lstat(agents);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error("Unsafe LaunchAgents directory.");
    if (job) await unloadJob(target);
    try {
      if (upgrading) await writeAgent(plist);
      else if (!previous) await writeFile(plistPath, plist, { flag: "wx", mode: 0o600 });
      await launchctl(["bootstrap", domain, plistPath]).catch(() => { throw new Error("macOS rejected the Dashboard LaunchAgent."); });
      await waitForDashboard(url);
    } catch (error) {
      if (!previous || upgrading) {
        if (await loadedJob(target)) await unloadJob(target);
        if (!previous) await unlink(plistPath);
        else {
          await writeAgent(previous);
          if (job) await launchctl(["bootstrap", domain, plistPath]);
        }
      }
      throw error;
    }
  } else await waitForDashboard(url);
  console.log(`Dashboard is available on demand at ${url}`);
}

try { await main(process.argv[2]); }
catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
