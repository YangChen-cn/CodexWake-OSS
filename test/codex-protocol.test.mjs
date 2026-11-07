import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Generates schemas locally with an empty home: no account or network needed.
// These checks catch relevant protocol drift when the locked CLI is upgraded;
// they do not prove that a live account has any particular quota semantics.
test("locked Codex CLI exposes the read-only probe schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "codexwake-schema-test-"));
  try {
    await execFileAsync(resolve("node_modules/.bin/codex"), ["app-server", "generate-json-schema", "--out", join(root, "schema")], {
      env: { PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: root }, timeout: 30000,
    });
    const schema = async (name) => JSON.parse(await readFile(join(root, "schema", "v2", `${name}.json`), "utf8"));
    const params = await schema("ModelListParams");
    assert.ok(params.properties.includeHidden.type.includes("boolean"));
    assert.ok(params.properties.cursor.type.includes("string"));
    const models = await schema("ModelListResponse");
    assert.equal(models.properties.data.type, "array");
    assert.equal(models.definitions.Model.properties.model.type, "string");
    assert.equal(models.definitions.Model.properties.hidden.type, "boolean");
    assert.ok(models.properties.nextCursor.type.includes("string"));
    const limits = await schema("GetAccountRateLimitsResponse");
    const limitParams = await schema("NullableGetAccountRateLimitsParams");
    assert.equal(limitParams.definitions.GetAccountRateLimitsParams.properties.excludeResetCreditDetails.type, "boolean");
    assert.ok(limits.properties.rateLimitsByLimitId.type.includes("object"));
    assert.ok(limits.properties.ordinaryUsageAllowed.type.includes("null"));
    assert.equal(limits.definitions.RateLimitWindow.properties.usedPercent.type, "integer");
    assert.ok(limits.definitions.RateLimitWindow.properties.windowDurationMins.type.includes("integer"));
    assert.ok(limits.definitions.RateLimitWindow.properties.resetsAt.type.includes("integer"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
