import { readState } from "./state.mjs";

const MIRRORED_REVISION = "codexwake:kv-mirrored-revision:v1";

// Best-effort, non-sensitive status mirror only. KV is eventually consistent
// and is never used for authorization, scheduling, locks or deduplication.
export async function mirrorStatusToKv(storage, kv) {
  if (!kv || typeof kv.put !== "function") return false;
  try {
    const state = await readState(storage);
    const last = await storage.get(MIRRORED_REVISION);
    if (Number.isSafeInteger(last) && last >= state.revision) return false;
    const snapshot = { revision: state.revision, phase: state.phase, autoEnabled: state.config.autoEnabled,
      timeZone: state.config.timeZone, estimatedNotBeforeMs: state.conservativeEstimate?.notBeforeMs ?? null,
      lastOutcome: state.lastActivation?.outcome ?? null, source: state.conservativeEstimate?.source ?? null };
    await kv.put("codexwake:status:v1", JSON.stringify(snapshot));
    await storage.transaction(async (tx) => {
      const prior = await tx.get(MIRRORED_REVISION);
      if (!Number.isSafeInteger(prior) || prior < state.revision) await tx.put(MIRRORED_REVISION, state.revision);
    });
    return true;
  } catch { return false; }
}
