import { configureMonitor, describeMonitor } from "../src/monitor-install.mjs";

try {
  const action = process.argv[2] ?? "status";
  const result = action === "status" ? await describeMonitor() : await configureMonitor(action);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch {
  process.stderr.write("Monitor operation failed. Check Codex hook configuration and permissions.\n");
  process.exitCode = 1;
}
