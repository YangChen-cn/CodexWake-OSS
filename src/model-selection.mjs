// model/list establishes availability, but does not supply subscription cost.
// The separately maintained ranking is operator-trusted metadata, not proof
// of actual per-turn cost; unavailable or stale data must not be guessed.
export function isLocallyAttested(attestation, model, nowMs, cliVersion) {
  return attestation?.source === "local_model_list" && attestation.model === model &&
    typeof attestation.cliVersion === "string" && /^\d+\.\d+\.\d+$/.test(attestation.cliVersion) &&
    (cliVersion === undefined || attestation.cliVersion === cliVersion) &&
    Number.isSafeInteger(attestation.verifiedAtMs) && attestation.verifiedAtMs >= 0 &&
    Number.isSafeInteger(nowMs) && nowMs >= attestation.verifiedAtMs;
}

export function selectModel({ models, selectedModel = null, ranking = null, nowMs }) {
  if (!Array.isArray(models) || !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      (selectedModel !== null && (typeof selectedModel !== "string" || !selectedModel.trim()))) {
    throw new Error("Invalid model selection input");
  }
  const available = new Set(models.filter((model) => model && typeof model.id === "string" && model.id && model.hidden !== true).map((model) => model.id));
  if (selectedModel !== null) {
    return available.has(selectedModel) ? { outcome: "selected", model: selectedModel, basis: "user" }
      : { outcome: "unavailable" };
  }
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  if (!ranking || typeof ranking !== "object" || !Number.isSafeInteger(ranking.verifiedAtMs) ||
      !Number.isSafeInteger(ranking.expiresAtMs) || ranking.verifiedAtMs < 0 || ranking.verifiedAtMs > nowMs ||
      ranking.expiresAtMs <= nowMs || ranking.expiresAtMs <= ranking.verifiedAtMs ||
      ranking.expiresAtMs - ranking.verifiedAtMs > maxAgeMs ||
      ranking.source !== "https://learn.chatgpt.com/docs/pricing" || !Array.isArray(ranking.models) ||
      ranking.models.length === 0 || ranking.models.length > 100 ||
      ranking.models.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) {
    return { outcome: "manual_selection_required" };
  }
  const candidate = ranking.models.find((id) => available.has(id));
  return candidate ? { outcome: "selected", model: candidate, basis: "maintained_ranking" }
    : { outcome: "manual_selection_required" };
}
