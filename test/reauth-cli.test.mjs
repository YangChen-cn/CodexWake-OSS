import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/policy.mjs";
import { assertPrivateRepository, reauthenticateFromEnvironment } from "../scripts/reauth.mjs";

test("credential import requires the intended GitHub repository to be private", async () => {
  const reply = (data) => async () => Response.json(data);
  await assertPrivateRepository("example", "private-repo", "synthetic", reply({ private: true, full_name: "example/private-repo" }));
  await assert.rejects(assertPrivateRepository("example", "private-repo", "synthetic", reply({ private: false, full_name: "example/private-repo" })));
  await assert.rejects(assertPrivateRepository("example", "private-repo", "synthetic", reply({ private: true, full_name: "example/other" })));
});

test("reauth CLI uses an isolated login and removes its local copy after confirmed registration", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "codexwake-reauth-test-"));
  const root = join(userHome, ".codexwake");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "admin-token"), "a".repeat(43), { mode: 0o600 });
  let loginHome;
  let registered;
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } });
  const admin = { status: async () => ({ phase: "WAITING", config: { ...DEFAULT_CONFIG, model: "current-model" },
    credentialUpdatePending: false, credentialBootstrap: null }) };
  try {
    const result = await reauthenticateFromEnvironment({ CODEXWAKE_CODEX_PATH: "/synthetic/codex", CODEXWAKE_RESUME: "yes", CODEXWAKE_ADMIN_URL: "https://worker.example", CODEXWAKE_GITHUB_OWNER: "example", CODEXWAKE_GITHUB_REPO: "private-repo" }, {
      userHome, allowNonInteractive: true, createAdmin: () => admin, getVersion: async () => "0.166.0",
      login: async (_path, home) => { loginHome = home; await writeFile(join(home, "auth.json"), auth, { mode: 0o600 }); },
      observe: async () => ({ models: [{ id: "current-model", isDefault: true }] }), getGitHubToken: async () => "synthetic-github",
      assertPrivateRepository: async (owner, repo) => { assert.equal(`${owner}/${repo}`, "example/private-repo"); },
      register: async (args) => { registered = args; return { outcome: "updated", enabled: true, model: "current-model", notBeforeMs: 42 }; },
    });
    assert.equal(result.enabled, true);
    assert.equal(registered.authText, auth);
    assert.equal(registered.githubConfig.token, "synthetic-github");
    assert.deepEqual(registered.models, [{ id: "current-model" }]);
    assert.equal(registered.resume, true);
    await assert.rejects(access(loginHome));
    assert.equal(JSON.stringify(result).includes("synthetic-refresh"), false);
  } finally { await rm(userHome, { recursive: true, force: true }); }
});

test("reauth CLI refuses to start a login while automation is enabled", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "codexwake-reauth-test-"));
  const root = join(userHome, ".codexwake");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "admin-token"), "a".repeat(43), { mode: 0o600 });
  let loginCalled = false;
  try {
    const result = await reauthenticateFromEnvironment({ CODEXWAKE_ADMIN_URL: "https://worker.example", CODEXWAKE_GITHUB_OWNER: "example", CODEXWAKE_GITHUB_REPO: "private-repo" }, { userHome, allowNonInteractive: true,
      createAdmin: () => ({ status: async () => ({ phase: "WAITING", config: { ...DEFAULT_CONFIG, autoEnabled: true } }) }),
      login: async () => { loginCalled = true; } });
    assert.equal(result.reason, "disable_and_wait_for_idle");
    assert.equal(loginCalled, false);
  } finally { await rm(userHome, { recursive: true, force: true }); }
});
