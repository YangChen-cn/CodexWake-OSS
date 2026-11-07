import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdminCoordinator } from "../src/admin-client.mjs";
import { validateConfig } from "../src/policy.mjs";

const AUTOMATIC_BLOCKED = "Automatic activity-based wakes are currently unavailable.";

function checkAutomaticAvailability(config, status) {
  if (config.autoEnabled && status.automaticBlockReason) throw new Error(AUTOMATIC_BLOCKED);
}

export async function configureFromEnvironment(mode, env, options = {}) {
  if (!["status", "set", "probe", "wake", "test-now", "enable", "disable", "pause", "resume", "cancel", "recover"].includes(mode) || typeof env.CODEXWAKE_ADMIN_URL !== "string" ||
      typeof env.CODEXWAKE_ADMIN_TOKEN !== "string") throw new Error("Invalid configuration command");
  const admin = (options.createAdmin ?? createAdminCoordinator)({ baseUrl: env.CODEXWAKE_ADMIN_URL, adminToken: env.CODEXWAKE_ADMIN_TOKEN });
  if (mode === "status") return admin.status();
  if (mode === "probe" || mode === "wake" || mode === "test-now") {
    const status = await admin.status();
    return mode === "probe" ? admin.startProbe({ expectedRevision: status.revision })
      : mode === "test-now" ? admin.startManualTest({ expectedRevision: status.revision })
        : admin.startWake({ expectedRevision: status.revision });
  }
  if (mode === "cancel") {
    const status = await admin.status();
    return admin.cancelWake({ expectedRevision: status.revision });
  }
  if (["enable", "disable", "pause", "resume"].includes(mode)) {
    const status = await admin.status();
    const config = validateConfig({ ...status.config, autoEnabled: mode === "enable" || mode === "resume" });
    checkAutomaticAvailability(config, status);
    return admin.setConfig({ config, expectedRevision: status.revision });
  }
  if (mode === "recover") {
    if (env.CODEXWAKE_CONFIRM_RECOVERY !== "yes") throw new Error("Explicit recovery confirmation required");
    const status = await admin.status();
    return admin.recover({ expectedRevision: status.revision });
  }
  if (typeof env.CODEXWAKE_CONFIG_FILE !== "string" || !isAbsolute(env.CODEXWAKE_CONFIG_FILE)) throw new Error("Configuration file must be absolute");
  const data = await (options.readFile ?? readFile)(env.CODEXWAKE_CONFIG_FILE);
  if (data.length > 8192) throw new Error("Configuration file too large");
  const config = validateConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
  const status = await admin.status();
  checkAutomaticAvailability(config, status);
  return admin.setConfig({ config, expectedRevision: status.revision });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Invalid arguments");
    const result = await configureFromEnvironment(process.argv[2], process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message === AUTOMATIC_BLOCKED ? AUTOMATIC_BLOCKED : "Configuration request failed. Check status, settings and documentation without printing secrets."}\n`);
    process.exitCode = 1;
  }
}
