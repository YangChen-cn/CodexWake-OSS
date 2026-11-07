import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runActivationTurn } from "../src/activation-executor.mjs";

const codexPath = fileURLToPath(new URL("../fixtures/fake-activation.mjs", import.meta.url));

test("one-shot executor isolates environment and passes the message via stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-turn-"));
  const started = Date.now();
  try {
    const result = await runActivationTurn({ codexPath, codexHome: root, cwd: root, model: "example-current-model", message: "synthetic-message" });
    assert.equal(result.outcome, "completed_unverified");
    assert.equal(result.responseReceived, true);
    assert.ok(result.startedAtMs >= started && result.finishedAtMs >= result.startedAtMs);
    const received = JSON.parse(await readFile(join(root, "activation-test.json"), "utf8"));
    assert.equal(received.input, "synthetic-message");
    assert.equal(received.args.includes("synthetic-message"), false);
    assert.equal(received.args.includes("example-current-model"), true);
    assert.equal(received.env.CODEX_HOME, root);
    assert.equal(received.env.HOME, root);
    // macOS can add this locale variable while starting /usr/bin/env.
    const allowed = new Set(["CODEX_HOME", "HOME", "LANG", "PATH", "__CF_USER_TEXT_ENCODING"]);
    assert.equal(Object.keys(received.env).every((key) => allowed.has(key)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a timeout is unconfirmed and is never retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-turn-"));
  try {
    const result = await runActivationTurn({ codexPath, codexHome: root, cwd: root, model: "example", message: "simulate-timeout", timeoutMs: 1000 });
    assert.equal(result.outcome, "unconfirmed");
    const received = JSON.parse(await readFile(join(root, "activation-test.json"), "utf8"));
    assert.equal(received.input, "simulate-timeout");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid configuration never starts the process", async () => {
  let started = false;
  await assert.rejects(runActivationTurn({ codexPath: "relative", codexHome: "/tmp", cwd: "/tmp", model: "x", message: "x" }, { spawn: () => { started = true; } }));
  assert.equal(started, false);
});

test("failure diagnostics expose only a safe category, not stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-turn-"));
  try {
    const result = await runActivationTurn({ codexPath, codexHome: root, cwd: root, model: "example", message: "simulate-auth-error" });
    assert.equal(result.outcome, "unconfirmed");
    assert.equal(result.reason, "possible_auth_error");
    assert.equal(JSON.stringify(result).includes("synthetic-secret-should-not-appear"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
