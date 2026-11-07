import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localRoot, privateDir, privateText } from "../src/local-activity.mjs";

try {
  await privateDir(localRoot);
  const path = join(localRoot, "activity-token");
  await writeFile(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const token = (await privateText(path)).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid reporter token");
  const wrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(wrangler, ["secret", "put", "ACTIVITY_REPORT_TOKEN"], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Worker secret upload failed")));
    child.stdin.end(token + "\n");
  });
  process.stdout.write("Activity reporter token configured. Automatic wakes retain their current settings.\n");
} catch {
  process.stderr.write("Could not configure reporter token. Check Wrangler login and local file permissions.\n");
  process.exitCode = 1;
}
