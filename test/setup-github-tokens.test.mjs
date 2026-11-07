import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function runSetup(mode, root) {
  const bin = join(root, "bin");
  await (await import("node:fs/promises")).mkdir(bin);
  await writeFile(join(bin, "gh"), `#!/bin/sh\nif [ "$1 $2" = 'repo view' ]; then echo true; elif [ "$1 $2" = 'secret set' ]; then cat > "$CODEXWAKE_TEST_DIR/secrets"; else exit 1; fi\n`, { mode: 0o755 });
  await writeFile(join(bin, "npx"), `#!/bin/sh\nif [ "$1 $2 $3 $4 $5" = '--no-install wrangler secret put GITHUB_ACTIONS_WRITE_TOKEN' ]; then cat > "$CODEXWAKE_TEST_DIR/actions"; else exit 1; fi\n`, { mode: 0o755 });
  const result = await execute("python3", [resolve("fixtures/interactive-token-test.py"), resolve("scripts/setup-github-tokens.sh"), mode], {
    env: { PATH: `${bin}:${process.env.PATH}`, CODEXWAKE_TEST_DIR: root, CODEXWAKE_GITHUB_REPOSITORY: "example/private-repo", HOME: root }, timeout: 20000,
  });
  return JSON.parse(result.stdout);
}

test("token setup keeps two synthetic tokens out of terminal output and command arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-token-test-"));
  try {
    assert.deepEqual(await runSetup("different", root), { code: 0, echoed: false, askedBoth: true });
    assert.equal(await readFile(join(root, "actions"), "utf8"), `github_pat_${"A".repeat(32)}`);
    assert.equal(await readFile(join(root, "secrets"), "utf8"), `github_pat_${"B".repeat(32)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("token setup refuses the same token before writing either secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-token-test-"));
  try {
    assert.deepEqual(await runSetup("same", root), { code: 1, echoed: false, askedBoth: true });
    await assert.rejects(readFile(join(root, "actions")));
    await assert.rejects(readFile(join(root, "secrets")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
