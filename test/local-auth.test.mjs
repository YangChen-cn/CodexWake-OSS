import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalAuthFile } from "../src/local-auth.mjs";

test("reads only an explicit private ChatGPT auth file and rejects symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codexwake-auth-test-"));
  const file = join(directory, "auth.json");
  const link = join(directory, "link.json");
  const text = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic", refresh_token: "synthetic" } });
  try {
    await writeFile(file, text, { mode: 0o600 });
    assert.equal(await readLocalAuthFile(file), text);
    await symlink(file, link);
    await assert.rejects(readLocalAuthFile(link), /unavailable or invalid/);
    await chmod(file, 0o644);
    await assert.rejects(readLocalAuthFile(file), /unavailable or invalid/);
    await assert.rejects(readLocalAuthFile("relative.json"), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
