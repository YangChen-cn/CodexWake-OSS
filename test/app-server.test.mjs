import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReadOnlyAppServer, readOnlyProbe, startReadOnlyCodex } from "../src/app-server.mjs";

test("read-only probe performs handshake and reads account, limits and models", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));
  const client = new ReadOnlyAppServer(spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "ignore"] }));
  try {
    const result = await readOnlyProbe(client);
    assert.equal(result.planType, "plus");
    assert.equal(result.limits.rateLimits.primary.windowDurationMins, 300);
    assert.deepEqual(result.models, [{ id: "example-current-model", isDefault: true }]);
    assert.equal(JSON.stringify(result).includes("never-export"), false);
    await assert.rejects(client.request("turn/start"), /not allowed/);
  } finally { await client.closeAndWait(); }
});

test("probe rejects relative or unspecified credential locations", () => {
  assert.throws(() => startReadOnlyCodex({ codexPath: "codex", codexHome: ".", cwd: "." }), /absolute/);
});
