#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
let input = "";
for await (const chunk of process.stdin) input += chunk;
await writeFile("activation-test.json", JSON.stringify({ args: process.argv.slice(2), env: process.env, input }));
if (input === "simulate-timeout") setInterval(() => {}, 1000);
else if (input === "simulate-auth-error") { process.stderr.write("401 Unauthorized synthetic-secret-should-not-appear"); process.exitCode = 1; }
else {
  const index = process.argv.indexOf("--output-last-message");
  if (index >= 0) await writeFile(process.argv[index + 1], "synthetic-model-response");
}
