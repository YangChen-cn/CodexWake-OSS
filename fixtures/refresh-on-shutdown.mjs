// Synthetic child process used to exercise the credential shutdown boundary.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const authPath = join(process.env.CODEX_HOME, "auth.json");
process.on("SIGTERM", async () => {
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  auth.tokens.refresh_token = "synthetic-refreshed-on-shutdown";
  await writeFile(authPath, JSON.stringify(auth));
  process.exit(0);
});

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
}
