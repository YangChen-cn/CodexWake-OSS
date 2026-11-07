import test from "node:test";
import assert from "node:assert/strict";
import { initialState, STATE_KEY } from "../src/state.mjs";
import { mirrorStatusToKv } from "../src/status-mirror.mjs";

test("KV mirrors only changed non-sensitive status and is never authoritative", async () => {
  let state = { ...initialState(), credentialGeneration: "663c2fc3-5099-45f7-9e1f-280ee522eefd" };
  let revision;
  const storage = { get: async (key) => key === STATE_KEY ? structuredClone(state) : revision,
    transaction: async (fn) => fn({ get: async () => revision, put: async (_key, value) => { revision = value; } }) };
  const writes = [];
  const kv = { put: async (key, value) => writes.push({ key, value: JSON.parse(value) }) };
  assert.equal(await mirrorStatusToKv(storage, kv), true);
  assert.equal(await mirrorStatusToKv(storage, kv), false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.autoEnabled, false);
  assert.equal(JSON.stringify(writes).includes(state.credentialGeneration), false);
  state = { ...state, revision: 1 };
  assert.equal(await mirrorStatusToKv(storage, kv), true);
  assert.equal(writes.length, 2);
  state = { ...state, revision: 2 };
  assert.equal(await mirrorStatusToKv(storage, { put: async () => { throw new Error("KV unavailable"); } }), false);
  assert.equal((await storage.get(STATE_KEY)).revision, 2);
});
