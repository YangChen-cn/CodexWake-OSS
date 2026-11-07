import { execFile } from "node:child_process";
import { join } from "node:path";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { startDashboard } from "../src/dashboard-server.mjs";
import { configuredWorker, localRoot, privateText } from "../src/local-activity.mjs";

try {
  const resident = process.argv.includes("--resident");
  const socketActivated = process.argv.includes("--socket-activated");
  const port = Number(process.env.CODEXWAKE_DASHBOARD_PORT ?? (resident ? 8787 : 0));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid dashboard port");
  const admin = createAdminCoordinator({ baseUrl: await configuredWorker(),
    adminToken: (await privateText(join(localRoot, "admin-token"))).trim() });
  const { origin } = await startDashboard({ admin, port, idleMs: resident ? null : socketActivated ? 60000 : undefined,
    fd: socketActivated ? 3 : undefined });
  process.stdout.write(`CodexWake Dashboard: ${origin}\n`);
  if (process.platform === "darwin" && !resident && !socketActivated && !process.argv.includes("--no-open")) execFile("/usr/bin/open", [origin], () => {});
} catch {
  process.stderr.write("Dashboard could not start. Check the local administrator token file and port.\n");
  process.exitCode = 1;
}
