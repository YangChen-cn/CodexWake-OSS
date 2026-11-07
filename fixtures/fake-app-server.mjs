import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  if (message.method === "initialize") result = {};
  else if (message.method === "account/read") result = { account: { type: "chatgpt", planType: "plus", email: "never-export@example.invalid" } };
  else if (message.method === "account/rateLimits/read" && message.params?.excludeResetCreditDetails === true && !message.params?.supportsLunaReserve) result = { rateLimits: { limitId: "codex", primary: { windowDurationMins: 300, resetsAt: 1800000000 } } };
  else if (message.method === "model/list") result = { data: [{ model: "example-current-model", isDefault: true }], nextCursor: null };
  else { process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601 } })}\n`); continue; }
  process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
}
