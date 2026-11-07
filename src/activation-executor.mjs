import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// Check only whether a bounded final-message file contains text. Never return
// the contents; the message may contain account or user data.
async function hasFinalMessage(path) {
  if (constants.O_NOFOLLOW === undefined) return false;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 65536) return false;
    const bytes = Buffer.alloc(Math.min(info.size, 8192));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString("utf8").trim().length > 0;
  } catch { return false; }
  finally { try { await file?.close(); } catch { /* no output data is returned */ } }
}

function classifyFailure(stderr, timedOut) {
  if (timedOut) return "timeout";
  if (/(unauthorized|refresh[_ -]?token|invalid_grant|\b401\b)/i.test(stderr)) return "possible_auth_error";
  if (/(model[^\n]{0,120}(not found|unsupported|not available|unknown)|\bmodel_not_found\b)/i.test(stderr)) return "model_unavailable";
  if (/(rate.?limit|\b429\b)/i.test(stderr)) return "rate_limited";
  if (/(unexpected argument|unrecognized option|unknown (argument|option|feature))/i.test(stderr)) return "cli_option_error";
  if (/(network|connection reset|tls)/i.test(stderr)) return "network_error";
  return "cli_failed";
}

// This module is intentionally not wired to a workflow yet. A caller must
// obtain a durable, single-use coordinator permit before calling it. A zero
// exit confirms only that the CLI exited successfully; it is not evidence of
// a new usage window. Never retry an unconfirmed or completed invocation.
export async function runActivationTurn({ codexPath, codexHome, cwd, model, message, timeoutMs = 120000 }, options = {}) {
  if (process.platform === "win32" || ![codexPath, codexHome, cwd].every((v) => typeof v === "string" && isAbsolute(v)) ||
      typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) ||
      typeof message !== "string" || !message.trim() || message.length > 1000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error("Invalid activation settings");

  const outputPath = join(cwd, "codexwake-last-message.txt");
  const args = ["-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral",
    "--sandbox", "read-only", "-c", 'cli_auth_credentials_store="file"',
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "plugins",
    "--disable", "browser_use", "--disable", "multi_agent", "--disable", "code_mode_host",
    "--model", model, "--output-last-message", outputPath, "-"];
  // The child cannot inherit the Runner's OIDC or GitHub credentials. HOME
  // is isolated as well as CODEX_HOME; the prompt is sent on stdin, not argv.
  const env = { PATH: process.env.PATH ?? "", HOME: cwd, CODEX_HOME: codexHome, LANG: "C.UTF-8" };
  const startedAtMs = Date.now();
  let child;
  try {
    child = (options.spawn ?? spawn)(codexPath, args, { cwd, env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
  } catch { return { outcome: "not_started", startedAtMs, finishedAtMs: Date.now() }; }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let started = false;
    let forceTimer;
    let finalTimer;
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 65536) stderr += String(chunk).slice(0, 65536 - stderr.length); });
    child.stderr.on("error", () => {});
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      const finishedAtMs = Date.now();
      if (outcome === "completed_unverified") {
        void hasFinalMessage(outputPath).then((responseReceived) => resolve({ outcome, startedAtMs, finishedAtMs, responseReceived }));
      } else resolve({ outcome, startedAtMs, finishedAtMs,
        ...(outcome === "unconfirmed" ? { reason: classifyFailure(stderr, timedOut) } : {}) });
    };
    const terminateGroup = (signal) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* Already exited or unconfirmed. */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup("SIGTERM");
      forceTimer = setTimeout(() => terminateGroup("SIGKILL"), 3000);
      // If exit cannot be observed, the caller must retain and isolate the
      // auth file; the process may still be using or refreshing it.
      finalTimer = setTimeout(() => finish("shutdown_unconfirmed"), 8000);
    }, timeoutMs);
    child.once("spawn", () => { started = true; });
    // An error after spawn does not confirm that all credential-using
    // processes have exited; the caller must retain the private auth file.
    child.once("error", () => finish(started ? "shutdown_unconfirmed" : "not_started"));
    child.once("close", (code, signal) => finish(!timedOut && code === 0 && signal === null ? "completed_unverified" : "unconfirmed"));
    child.stdin.on("error", () => { /* A failed stdin does not prove no request was sent. */ });
    child.stdin.end(message);
  });
}
