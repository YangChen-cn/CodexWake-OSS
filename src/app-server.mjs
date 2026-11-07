import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const METHODS = new Set(["initialize", "account/read", "account/rateLimits/read", "model/list"]);
const MAX_LINE = 1024 * 1024;

// Read-only JSON-RPC client. It intentionally has no API to start a turn,
// log in, redeem resets, or run commands. Never log server output or errors.
export class ReadOnlyAppServer {
  constructor(child, timeoutMs = 15000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid RPC timeout");
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stdout.on("error", () => this.fail("Codex app-server output failed"));
    child.stdin.on("error", () => this.fail("Codex app-server input failed"));
    child.on("error", () => this.fail("Codex app-server failed to start"));
    child.on("exit", () => this.fail("Codex app-server exited"));
  }

  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      if (index > MAX_LINE) return this.fail("Codex app-server response too large");
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { return this.fail("Invalid Codex app-server response"); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail("Invalid Codex app-server response");
      if (message.method && message.id !== undefined) return this.fail("Unexpected Codex app-server request");
      if (message.id === undefined) continue; // Notifications contain no data needed by this probe.
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error || !Object.hasOwn(message, "result")) pending.reject(new Error("Codex app-server request failed"));
      else pending.resolve(message.result);
    }
    if (this.buffer.length > MAX_LINE) this.fail("Codex app-server response too large");
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.child.kill();
  }

  request(method, params = {}) {
    if (!METHODS.has(method)) return Promise.reject(new Error("Method is not allowed in read-only probe"));
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("Codex app-server request timed out"), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "codexwake", title: "CodexWake", version: "0.1.0" } });
    if (this.closed) throw new Error("Codex app-server is closed");
    this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  }

  close() { this.fail("Codex app-server closed"); }

  // A caller must wait for process termination before reading auth.json: the
  // child could otherwise finish a refresh after the old file was saved.
  async closeAndWait(timeoutMs = 5000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid shutdown timeout");
    if (this.child.exitCode !== null || this.child.signalCode !== null) { this.close(); return; }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.removeListener("close", onClose);
        this.child.kill("SIGKILL");
        reject(new Error("Codex app-server shutdown unconfirmed"));
      }, timeoutMs);
      const onClose = () => { clearTimeout(timer); resolve(); };
      this.child.once("close", onClose);
      this.close();
    });
  }
}

// An isolated CODEX_HOME is mandatory. No API keys, GitHub credentials, or
// ambient environment variables are passed to the child process.
export function startReadOnlyCodex({ codexPath, codexHome, cwd, timeoutMs }) {
  if (![codexPath, codexHome, cwd].every((value) => typeof value === "string" && isAbsolute(value))) {
    throw new Error("Codex executable, isolated CODEX_HOME, and cwd must be absolute paths");
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)) {
    throw new Error("Invalid RPC timeout");
  }
  const env = { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome, LANG: "C.UTF-8" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const child = spawn(codexPath, ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"'],
    { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  return new ReadOnlyAppServer(child, timeoutMs);
}

// This call can cause Codex to refresh auth.json even though it sends no
// model message. The caller must hold the credential lock and persist changes.
export async function readOnlyProbe(client) {
  await client.initialize();
  const account = await client.request("account/read", { refreshToken: false });
  if (account?.account?.type !== "chatgpt") throw new Error("ChatGPT managed authentication required");
  // Background checks do not need individual reset-credit details. Do not
  // opt in to fallback behavior or redeem any credits during this probe.
  const limits = await client.request("account/rateLimits/read", { excludeResetCreditDetails: true });
  const models = [];
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const result = await client.request("model/list", { limit: 100, includeHidden: false, cursor });
    if (!Array.isArray(result?.data)) throw new Error("Invalid Codex model list");
    for (const model of result.data) {
      if (typeof model?.model === "string" && model.model && model.hidden !== true) {
        models.push({ id: model.model, isDefault: model.isDefault === true });
      }
    }
    cursor = result.nextCursor ?? null;
    if (cursor === null) return { planType: account.account.planType ?? null, limits, models };
    if (typeof cursor !== "string" || !cursor || seen.has(cursor)) throw new Error("Invalid model pagination");
    seen.add(cursor);
  }
  throw new Error("Codex model pagination limit exceeded");
}
