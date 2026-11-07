import test from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "../src/model-selection.mjs";

const nowMs = 1800000000000;
const models = [{ id: "new-model-a" }, { id: "new-model-b" }, { id: "hidden-model", hidden: true }];
const ranking = { source: "https://learn.chatgpt.com/docs/pricing", verifiedAtMs: nowMs - 1000,
  expiresAtMs: nowMs + 86400000, models: ["retired-model", "new-model-b", "new-model-a"] };

test("chooses a currently available model from maintained cost ranking", () => {
  assert.deepEqual(selectModel({ models, ranking, nowMs }), { outcome: "selected", model: "new-model-b", basis: "maintained_ranking" });
});

test("explicit selection must exist in the actual visible model list", () => {
  assert.deepEqual(selectModel({ models, selectedModel: "new-model-a", nowMs }), { outcome: "selected", model: "new-model-a", basis: "user" });
  assert.deepEqual(selectModel({ models, selectedModel: "hidden-model", nowMs }), { outcome: "unavailable" });
  assert.deepEqual(selectModel({ models, selectedModel: "retired-model", nowMs }), { outcome: "unavailable" });
});

test("missing, expired or untrusted ranking does not guess a default", () => {
  for (const value of [null, { ...ranking, expiresAtMs: nowMs }, { ...ranking, source: "https://example.test" },
    { ...ranking, models: ["retired-model"] }, { ...ranking, verifiedAtMs: nowMs + 1 }]) {
    assert.deepEqual(selectModel({ models, ranking: value, nowMs }), { outcome: "manual_selection_required" });
  }
});
