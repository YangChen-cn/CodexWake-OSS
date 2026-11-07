import { WINDOW_MS, planWakes, consumeWake, validateAppointments } from "./wake-planning.mjs";
import { ACTIVITY_GRACE_MS, WAKE_TTL_MS, evaluateActivityWake, validateActivity } from "./activity-policy.mjs";
import { DEFAULT_CONFIG, validateConfig, evaluateSchedule } from "./policy.mjs";
import { evaluateEligibility } from "./eligibility.mjs";
import { initialConservativeWindow, nextConservativeWindow, evaluateConservativeWindow } from "./conservative-window.mjs";
import { isLocallyAttested, selectModel } from "./model-selection.mjs";

export const STATE_KEY = "codexwake:state:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function initialState() {
  return {
    schemaVersion: 1,
    revision: 0,
    configGeneration: 0,
    phase: "WAITING",
    config: { ...DEFAULT_CONFIG },
    credentialGeneration: null,
    credentialUpdate: null,
    credentialBootstrap: null,
    lastBootstrap: null,
    quotaSnapshot: null,
    attempt: null,
    lastProbe: null,
  };
}

function validateStoredState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.configGeneration) || state.configGeneration < 0 ||
      !["WAITING", "DISPATCHING", "ACTIVATING", "FAILED"].includes(state.phase) ||
      (state.phase === "WAITING" && state.attempt !== null) ||
      (["DISPATCHING", "ACTIVATING", "FAILED"].includes(state.phase) && (!state.attempt || !UUID.test(state.attempt.id) ||
        !["automatic", "manual_probe", "estimated_activation", "manual_test", "activity_wake"].includes(state.attempt.kind) ||
        !UUID.test(state.attempt.credentialGeneration) ||
        !Number.isSafeInteger(state.attempt.configGeneration) || state.attempt.configGeneration < 0 ||
        !Number.isSafeInteger(state.attempt.reservedAtMs) || state.attempt.reservedAtMs < 0 ||
        !state.attempt.dispatch || !["reserved", "accepted", "unknown", "rejected"].includes(state.attempt.dispatch.outcome) ||
        (state.attempt.dispatch.outcome === "accepted" &&
          (typeof state.attempt.dispatch.runId !== "string" || !/^[1-9]\d*$/.test(state.attempt.dispatch.runId))))) ||
      (["ACTIVATING", "FAILED"].includes(state.phase) && (!["estimated_activation", "manual_test", "activity_wake"].includes(state.attempt.kind) ||
        !Number.isSafeInteger(state.attempt.permitIssuedAtMs) || state.attempt.permitIssuedAtMs < 0)) ||
      (state.credentialUpdate !== null && (!state.credentialUpdate || !["DISPATCHING", "ACTIVATING"].includes(state.phase) ||
        !UUID.test(state.credentialUpdate.from) || !UUID.test(state.credentialUpdate.to) ||
        state.credentialUpdate.from === state.credentialUpdate.to || !["prepared", "writing"].includes(state.credentialUpdate.writeState))) ||
      (state.credentialBootstrap !== null && (!state.credentialBootstrap || state.phase !== "WAITING" ||
        state.config.autoEnabled !== false || !UUID.test(state.credentialBootstrap.generation) ||
        !/^[a-f0-9]{64}$/.test(state.credentialBootstrap.digest) || !["prepared", "writing"].includes(state.credentialBootstrap.writeState)))) {
    throw new Error("Invalid or unsupported coordinator state");
  }
  validateConfig(state.config);
  return state;
}

// Reserve the exact bundle before a local operator uploads it. The digest is
// of a high-entropy credential bundle and prevents reusing a generation with
// different content after a response is lost. No credential reaches Workers.
export async function prepareCredentialBootstrap(storage, { generation, digest, expectedRevision }) {
  if (typeof generation !== "string" || !UUID.test(generation) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid credential bootstrap");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.credentialBootstrap) {
      if (current.credentialBootstrap.generation === generation && current.credentialBootstrap.digest === digest) return current;
      throw new Error("A different credential bootstrap is pending");
    }
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.config.autoEnabled !== false || current.credentialUpdate !== null) {
      throw new Error("Credential bootstrap requires a disabled idle coordinator");
    }
    if (current.credentialGeneration === generation) throw new Error("Credential generation must change");
    const next = { ...current, revision: current.revision + 1, credentialBootstrap: { generation, digest, writeState: "prepared" } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// This is a one-shot grant, not an idempotent operation. If its response is
// lost, the caller must not PUT: another grant could create a late stale PUT.
export async function authorizeBootstrapWrite(storage, { generation, digest }) {
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const pending = current.credentialBootstrap;
    if (!pending || pending.generation !== generation || pending.digest !== digest || pending.writeState !== "prepared") {
      throw new Error("Credential bootstrap write is not authorized");
    }
    const next = { ...current, revision: current.revision + 1, credentialBootstrap: { ...pending, writeState: "writing" } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Only after GitHub confirms the PUT may the local operator commit metadata.
export async function commitCredentialBootstrap(storage, { generation, digest }) {
  if (typeof generation !== "string" || !UUID.test(generation) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid credential bootstrap");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (!current.credentialBootstrap) {
      if (current.credentialGeneration === generation && current.lastBootstrap?.generation === generation && current.lastBootstrap.digest === digest) return current;
      throw new Error("No matching credential bootstrap");
    }
    if (current.credentialBootstrap.generation !== generation || current.credentialBootstrap.digest !== digest ||
        current.credentialBootstrap.writeState !== "writing") {
      throw new Error("Credential bootstrap does not match reservation");
    }
    const next = { ...current, revision: current.revision + 1, credentialGeneration: generation,
      credentialBootstrap: null, lastBootstrap: { generation, digest }, quotaSnapshot: null, lastProbe: null };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

function requireClaimedAttempt(state, attemptId, identity) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !identity ||
      typeof identity.runId !== "string" || !/^[1-9]\d*$/.test(identity.runId) || identity.runAttempt !== "1") {
    throw new Error("Invalid credential update identity");
  }
  if (!["DISPATCHING", "ACTIVATING"].includes(state.phase) || state.attempt.id !== attemptId ||
      state.attempt.runId !== identity.runId || state.attempt.runAttempt !== identity.runAttempt) {
    throw new Error("Credential update is not owned by this run");
  }
}

// Completes only a read-only probe, never an activation. A repeated report
// from the same run is idempotent and cannot overwrite a newer observation.
export async function completePreflight(storage, { attemptId, identity, snapshot, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !identity ||
      typeof identity.runId !== "string" || !/^[1-9]\d*$/.test(identity.runId) || identity.runAttempt !== "1" ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 || !snapshot || typeof snapshot !== "object" ||
      Object.keys(snapshot).sort().join(",") !== "limitId,observedAtMs,resetAtMs,source,usedPercent,windowDurationMins" ||
      snapshot.source !== "account/rateLimits/read" || typeof snapshot.limitId !== "string" || !snapshot.limitId ||
      snapshot.limitId.length > 200 || snapshot.windowDurationMins !== 300 ||
      !Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs < 0 ||
      !Number.isSafeInteger(snapshot.resetAtMs) || snapshot.resetAtMs < snapshot.observedAtMs ||
      typeof snapshot.usedPercent !== "number" || !Number.isFinite(snapshot.usedPercent) ||
      snapshot.usedPercent < 0 || snapshot.usedPercent > 100) throw new Error("Invalid preflight report");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const prior = current.lastProbe;
    if (prior?.attemptId === attemptId && prior.runId === identity.runId && prior.runAttempt === identity.runAttempt) {
      if (Object.keys(snapshot).every((key) => prior.snapshot[key] === snapshot[key])) return current;
      throw new Error("Preflight report conflicts with the previous result");
    }
    if (snapshot.observedAtMs > nowMs + 30000 || nowMs - snapshot.observedAtMs > 900000 || snapshot.resetAtMs < nowMs) {
      throw new Error("Preflight observation is stale");
    }
    requireClaimedAttempt(current, attemptId, identity);
    if (current.phase !== "DISPATCHING" || ["estimated_activation", "manual_test", "activity_wake"].includes(current.attempt.kind)) {
      throw new Error("Activation attempts cannot report a read-only probe");
    }
    if (current.credentialUpdate !== null) throw new Error("Credential update remains unconfirmed");
    const savedGeneration = current.attempt.committedGeneration ?? current.attempt.credentialGeneration;
    if (current.credentialGeneration !== savedGeneration) throw new Error("Credential generation is inconsistent");
    const next = { ...current, revision: current.revision + 1, phase: "WAITING", attempt: null,
      quotaSnapshot: { ...snapshot }, lastProbe: { attemptId, runId: identity.runId, runAttempt: identity.runAttempt, snapshot: { ...snapshot } } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Reserve a generation before sending GitHub the encrypted updated secret.
// This record is deliberately never auto-expired, even if the Runner vanishes.
export async function prepareCredentialRotation(storage, { attemptId, identity, from, to }) {
  if (typeof from !== "string" || typeof to !== "string" || !UUID.test(from) || !UUID.test(to) || from === to) {
    throw new Error("Invalid credential generations");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    requireClaimedAttempt(current, attemptId, identity);
    if (current.credentialUpdate) {
      if (current.credentialUpdate.from === from && current.credentialUpdate.to === to) return current;
      throw new Error("Another credential update is in progress");
    }
    if (current.credentialGeneration !== from || current.attempt.credentialGeneration !== from) {
      throw new Error("Stale credential generation");
    }
    const next = { ...current, revision: current.revision + 1, credentialUpdate: { from, to, writeState: "prepared" } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function authorizeCredentialWrite(storage, { attemptId, identity, to }) {
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    requireClaimedAttempt(current, attemptId, identity);
    const pending = current.credentialUpdate;
    if (!pending || pending.to !== to || pending.writeState !== "prepared") throw new Error("Credential write is not authorized");
    const next = { ...current, revision: current.revision + 1, credentialUpdate: { ...pending, writeState: "writing" } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Only call after the Runner has received a 201/204 from GitHub. OIDC identity
// and the result must be verified by the future endpoint before reaching here.
export async function commitCredentialRotation(storage, { attemptId, identity, to }) {
  if (typeof to !== "string" || !UUID.test(to)) throw new Error("Invalid credential generation");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    requireClaimedAttempt(current, attemptId, identity);
    if (!current.credentialUpdate) {
      if (current.credentialGeneration === to && current.attempt.committedGeneration === to) return current;
      throw new Error("No matching credential update");
    }
    if (current.credentialUpdate.to !== to || current.credentialGeneration !== current.credentialUpdate.from ||
        current.credentialUpdate.writeState !== "writing") {
      throw new Error("Credential update does not match reservation");
    }
    const next = { ...current, revision: current.revision + 1, credentialGeneration: to, credentialUpdate: null,
      attempt: { ...current.attempt, committedGeneration: to } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Reserves a preflight once; it never makes a network request. No automatic
// expiry or release exists yet: an ambiguous dispatch must remain blocked.
export async function reservePreflight(storage, { attemptId, expectedRevision, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid reservation input");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING") throw new Error("A preflight is already in progress");
    if (current.credentialBootstrap !== null) throw new Error("Credential bootstrap is pending");
    if (typeof current.credentialGeneration !== "string" || !UUID.test(current.credentialGeneration)) {
      throw new Error("Credential generation is unavailable");
    }
    const eligibility = evaluateEligibility({ config: current.config, now: new Date(nowMs), snapshot: current.quotaSnapshot });
    if (!eligibility.candidate) throw new Error(`Preflight not due: ${eligibility.reason}`);
    const next = {
      ...current,
      revision: current.revision + 1,
      phase: "DISPATCHING",
      attempt: {
        id: attemptId,
        kind: "automatic",
        reservedAtMs: nowMs,
        configGeneration: current.configGeneration,
        credentialGeneration: current.credentialGeneration,
        runId: null,
        runAttempt: null,
        dispatch: { outcome: "reserved", runId: null },
      },
    };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Only a separately authenticated administrator may request this operation.
// It authorizes a read-only probe, never a model turn, and solves the initial
// no-snapshot bootstrap without weakening automatic scheduling rules.
export async function reserveManualProbe(storage, { attemptId, expectedRevision, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid manual probe reservation");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.credentialBootstrap !== null || current.credentialUpdate !== null) {
      throw new Error("Coordinator is busy");
    }
    if (typeof current.credentialGeneration !== "string" || !UUID.test(current.credentialGeneration)) {
      throw new Error("Credential generation is unavailable");
    }
    const next = { ...current, revision: current.revision + 1, phase: "DISPATCHING", attempt: {
      id: attemptId, kind: "manual_probe", reservedAtMs: nowMs, configGeneration: current.configGeneration,
      credentialGeneration: current.credentialGeneration, runId: null, runAttempt: null,
      dispatch: { outcome: "reserved", runId: null },
    } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Called only by the orchestrator after its one GitHub dispatch request. A
// timeout stays unknown even if a valid-looking Runner arrives later.
export async function recordDispatchOutcome(storage, { attemptId, outcome, runId = null, httpStatus = null }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !["accepted", "unknown", "rejected"].includes(outcome) ||
      (outcome === "accepted" ? typeof runId !== "string" || !/^[1-9]\d*$/.test(runId) : runId !== null) ||
      (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
    throw new Error("Invalid dispatch outcome");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.phase !== "DISPATCHING" || current.attempt.id !== attemptId) throw new Error("Unknown dispatch attempt");
    const previous = current.attempt.dispatch;
    if (previous.outcome !== "reserved") {
      if (previous.outcome === outcome && previous.runId === runId && (previous.httpStatus ?? null) === httpStatus) return current;
      throw new Error("Dispatch outcome already recorded");
    }
    const next = { ...current, revision: current.revision + 1,
      attempt: { ...current.attempt, dispatch: { outcome, runId, ...(httpStatus === null ? {} : { httpStatus }) } } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// A definitive GitHub rejection cannot have started a run. Never use this
// for reserved or unknown responses, which could still have been accepted.
export async function releaseRejectedManualTest(storage, { attemptId, expectedRevision }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Invalid rejected test release");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision || current.phase !== "DISPATCHING" || current.config.autoEnabled !== false ||
        current.attempt?.id !== attemptId || current.attempt.kind !== "manual_test" ||
        current.attempt.dispatch.outcome !== "rejected" || current.attempt.dispatch.runId !== null ||
        current.attempt.runId !== null || current.attempt.runAttempt !== null ||
        current.credentialUpdate !== null || current.credentialBootstrap !== null) throw new Error("Rejected test release is unsafe");
    const next = { ...current, revision: current.revision + 1, phase: "WAITING", attempt: null };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Identity must be the output of a successfully verified GitHub OIDC token;
// nowMs must be supplied by the server, never by the HTTP caller. Claiming a
// preflight does not authorize a model request.
export async function claimPreflight(storage, { attemptId, credentialGeneration, identity, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) ||
      typeof credentialGeneration !== "string" || !UUID.test(credentialGeneration) ||
      !identity || typeof identity.runId !== "string" || !/^[1-9]\d*$/.test(identity.runId) ||
      identity.runAttempt !== "1" || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid preflight claim");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const attempt = current.attempt;
    if (current.phase !== "DISPATCHING" || attempt.id !== attemptId) throw new Error("Unknown preflight attempt");
    if (attempt.dispatch.outcome !== "accepted" || attempt.dispatch.runId !== identity.runId) {
      throw new Error("Runner does not match confirmed dispatch");
    }
    if (current.credentialGeneration !== credentialGeneration || attempt.credentialGeneration !== credentialGeneration) {
      throw new Error("Stale credential generation");
    }
    if (attempt.kind !== "activity_wake" && attempt.configGeneration !== current.configGeneration) throw new Error("Configuration changed after reservation");
    if (attempt.kind === "automatic") {
      const eligibility = evaluateEligibility({ config: current.config, now: new Date(nowMs), snapshot: current.quotaSnapshot });
      if (!eligibility.candidate) throw new Error(`Preflight no longer permitted: ${eligibility.reason}`);
    }
    if (attempt.kind === "estimated_activation") {
      const eligibility = evaluateConservativeWindow({ config: current.config, estimate: current.conservativeEstimate,
        acknowledged: current.conservativeAcknowledged, nowMs });
      if (!eligibility.candidate) throw new Error(`Activation no longer permitted: ${eligibility.reason}`);
      if (current.estimatedRetry && (!Number.isSafeInteger(current.estimatedRetry.notBeforeMs) || nowMs < current.estimatedRetry.notBeforeMs)) {
        throw new Error("Retry interval not reached");
      }
    }
    if (attempt.kind === "manual_test" && current.config.autoEnabled !== false) throw new Error("Manual test requires automatic activation disabled");
    if (attempt.runId !== null || attempt.runAttempt !== null) {
      if (attempt.runId === identity.runId && attempt.runAttempt === identity.runAttempt) return current;
      throw new Error("Preflight claimed by another run");
    }
    const next = { ...current, revision: current.revision + 1,
      attempt: { ...attempt, runId: identity.runId, runAttempt: identity.runAttempt } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// These functions are not exposed by the Worker yet. Enrollment requires an
// explicit administrator acknowledgement; no estimate is ever a quota fact.
export async function enrollConservativeMode(storage, { acknowledged, expectedRevision, nowMs }) {
  if (acknowledged !== true || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Conservative mode requires explicit acknowledgement");
  }
  const estimate = initialConservativeWindow({ nowMs, acknowledged });
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.config.autoEnabled !== false || current.credentialUpdate !== null ||
        current.credentialBootstrap !== null || !UUID.test(current.credentialGeneration ?? "")) {
      throw new Error("Conservative enrollment requires disabled idle state and credentials");
    }
    const next = { ...current, revision: current.revision + 1, conservativeAcknowledged: true, conservativeEstimate: estimate, estimatedRetry: null };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Administrator supplies a catalog observed locally from the same locked CLI
// version. It is evidence of past availability, not a guaranteed expiry date.
export async function attestLocalModelCatalog(storage, { models, cliVersion, expectedRevision, nowMs }) {
  if (!Array.isArray(models) || models.length > 500 || typeof cliVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(cliVersion) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid local model catalog");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.config.autoEnabled !== false || current.credentialBootstrap !== null) {
      throw new Error("Model catalog attestation requires disabled idle state");
    }
    if (current.config.model === null) throw new Error("No model selected");
    const selected = selectModel({ models, selectedModel: current.config.model, nowMs });
    if (selected.outcome !== "selected" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selected.model)) throw new Error("Model not in catalog");
    const modelAttestation = { source: "local_model_list", model: selected.model, cliVersion, verifiedAtMs: nowMs };
    const next = { ...current, revision: current.revision + 1, modelAttestation };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Explicit administrator-only test: it bypasses the schedule and estimate
// once, while keeping automatic activation disabled and the single-flight lock.
export async function reserveManualTest(storage, { attemptId, expectedRevision, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid manual test reservation");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.config.autoEnabled !== false || current.credentialBootstrap !== null || current.credentialUpdate !== null) {
      throw new Error("Manual test requires disabled idle state");
    }
    if (!UUID.test(current.credentialGeneration ?? "")) throw new Error("Credential generation is unavailable");
    const next = { ...current, revision: current.revision + 1, phase: "DISPATCHING", attempt: {
      id: attemptId, kind: "manual_test", reservedAtMs: nowMs, configGeneration: current.configGeneration,
      credentialGeneration: current.credentialGeneration, runId: null, runAttempt: null,
      dispatch: { outcome: "reserved", runId: null },
    } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function recordLocalActivity(storage, event, nowMs, enabled) {
  validateActivity(event, nowMs);
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const prior = current.activityWake;
    if (event.activityAtMs <= (current.activityCutoffMs ?? 0) ||
        (prior && (event.eventId === prior.eventId || event.activityAtMs <= prior.activityAtMs))) {
      return { state: current, outcome: "duplicate_or_before_cutoff" };
    }
    if (prior && event.resetAtMs === prior.resetAtMs && prior.status !== "ignored") {
      return { state: current, outcome: "window_already_recorded" };
    }
    if (prior && event.resetAtMs !== prior.resetAtMs && event.activityAtMs < prior.resetAtMs) {
      // The reset changed within the previously observed window. Its identity
      // is ambiguous. Skip it and wait until real activity in a later window.
      const next = { ...current, revision: current.revision + 1,
        idleWakes: 0, continuation: null,
        activityWake: { ...(event.resetAtMs > prior.resetAtMs ? event : prior), status: "canceled", reason: "reset_changed" } };
      await tx.put(STATE_KEY, next);
      return { state: next, outcome: "reset_changed" };
    }
    const canArm = enabled && current.config.autoEnabled && current.credentialGeneration &&
      current.credentialBootstrap === null && current.credentialUpdate === null &&
      current.phase !== "FAILED" && (current.phase === "WAITING" || current.attempt?.kind === "activity_wake");
    const next = { ...current, revision: current.revision + 1,
      idleWakes: 0, continuation: null,
      activityWake: { ...event, status: canArm ? "armed" : "ignored", reason: canArm ? null : "disabled_or_busy" } };
    await tx.put(STATE_KEY, next);
    return { state: next, outcome: next.activityWake.status };
  });
}

function canceledActivity(state, reason) {
  if (["armed", "reserved"].includes(state.activityWake?.status)) {
    return { ...state.activityWake, status: "canceled", reason };
  }
  return state.activityWake ?? null;
}

export async function cancelActivityWake(storage, { expectedRevision, nowMs }) {
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    const rejected = current.phase === "DISPATCHING" && current.attempt?.kind === "activity_wake" &&
      current.attempt.dispatch.outcome === "rejected" && current.attempt.runId === null;
    const wake = current.phase === "DISPATCHING" && current.attempt?.wake
      ? current.attempt.wake : planWakes(current, nowMs).candidates[0];
    const next = { ...current, revision: current.revision + 1,
      ...(wake?.source === "appointment" ? consumeWake(current, wake, "canceled") : {}),
      activityCutoffMs: nowMs, activityWake: canceledActivity(current, "canceled"), continuation: null,
      ...(rejected ? { phase: "WAITING", attempt: null } : {}) };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function reserveActivityWake(storage, { attemptId, expectedRevision, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId)) throw new Error("Invalid attempt ID");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) return { reason: "revision_conflict" };
    if (current.phase !== "WAITING") return { reason: "in_flight" };
    const schedule = evaluateSchedule(current.config, new Date(nowMs));
    const wake = planWakes(current, nowMs).candidates[0];
    const reason = evaluateActivityWake(current, nowMs);
    if (!wake && reason === "activity_expired") {
      await tx.put(STATE_KEY, { ...current, revision: current.revision + 1,
        activityWake: { ...current.activityWake, status: "expired", reason } });
    }
    if (!wake) return { reason: reason ?? "no_pending_activity" };
    if (nowMs < wake.dueAtMs) return { reason: "waiting_for_reset" };
    if (!schedule.permitted) return { reason: schedule.reason };
    if (current.credentialBootstrap !== null || current.credentialUpdate !== null || !UUID.test(current.credentialGeneration ?? "")) {
      return { reason: "credentials_unavailable" };
    }
    if (!isLocallyAttested(current.modelAttestation, current.config.model, nowMs)) return { reason: "model_attestation_missing" };
    const next = { ...current, revision: current.revision + 1, phase: "DISPATCHING",
      ...(wake.source === "user_activity" ? { activityWake: { ...current.activityWake, status: "reserved" } } : {}),
      attempt: { id: attemptId, kind: "activity_wake", windowKey: wake.key, wake, reservedAtMs: nowMs,
        configGeneration: current.configGeneration, credentialGeneration: current.credentialGeneration,
        runId: null, runAttempt: null, dispatch: { outcome: "reserved", runId: null } } };
    await tx.put(STATE_KEY, next);
    return { reason: null };
  });
}

// A Runner can release an unused reservation only after confirming credential
// persistence. A lost permit reply leaves phase ACTIVATING and cannot use this.
export async function skipActivityWake(storage, { attemptId, identity }) {
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const prior = current.lastSkippedWake;
    if (prior?.attemptId === attemptId && prior.runId === identity.runId && prior.runAttempt === identity.runAttempt) return current;
    requireClaimedAttempt(current, attemptId, identity);
    const attempt = current.attempt;
    if (current.phase !== "DISPATCHING" || attempt.kind !== "activity_wake" || current.credentialUpdate !== null ||
        current.credentialGeneration !== (attempt.committedGeneration ?? attempt.credentialGeneration)) {
      throw new Error("Wake skip is unsafe");
    }
    const wake = current.activityWake;
    const configChanged = attempt.configGeneration !== current.configGeneration;
    const next = { ...current, revision: current.revision + 1, phase: "WAITING", attempt: null,
      activityWake: wake?.windowKey === attempt.windowKey && wake.status === "reserved"
        ? configChanged && current.config.autoEnabled ? { ...wake, status: "armed" }
          : { ...wake, status: "canceled", reason: "permit_not_granted" } : wake,
      ...(!configChanged && attempt.wake?.source === "rolling" && current.continuation?.key === attempt.windowKey ? { continuation: null } : {}),
      ...(attempt.wake?.source === "appointment" && attempt.configGeneration === current.configGeneration
        ? consumeWake(current, attempt.wake, "permit_not_granted") : {}),
      lastSkippedWake: { attemptId, runId: identity.runId, runAttempt: identity.runAttempt, windowKey: attempt.windowKey } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function reserveEstimatedActivation(storage, { attemptId, expectedRevision, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid activation reservation");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.phase !== "WAITING" || current.credentialBootstrap !== null || current.credentialUpdate !== null) throw new Error("Coordinator is busy");
    if (!UUID.test(current.credentialGeneration ?? "")) throw new Error("Credential generation is unavailable");
    const due = evaluateConservativeWindow({ config: current.config, estimate: current.conservativeEstimate,
      acknowledged: current.conservativeAcknowledged, nowMs });
    if (!due.candidate) throw new Error(`Estimated activation not due: ${due.reason}`);
    if (current.estimatedRetry && (current.estimatedRetry.anchorMs !== current.conservativeEstimate.anchorMs ||
        !Number.isSafeInteger(current.estimatedRetry.count) || current.estimatedRetry.count < 1 ||
        !Number.isSafeInteger(current.estimatedRetry.notBeforeMs) || nowMs < current.estimatedRetry.notBeforeMs)) {
      throw new Error("Retry interval not reached or retry state invalid");
    }
    const next = { ...current, revision: current.revision + 1, phase: "DISPATCHING", attempt: {
      id: attemptId, kind: "estimated_activation", reservedAtMs: nowMs, configGeneration: current.configGeneration,
      credentialGeneration: current.credentialGeneration, runId: null, runAttempt: null,
      dispatch: { outcome: "reserved", runId: null },
    } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// Irreversible, one-shot permission. A lost response means the Runner must
// NOT send: retrying could allow a delayed duplicate. Models must originate in
// the trusted Runner's fresh CLI model list, not from workflow inputs.
export async function authorizeEstimatedActivation(storage, { attemptId, identity, models, cliVersion, accountTag, activityWakesEnabled = false, nowMs }) {
  if (!Array.isArray(models) || models.length > 2000 || (cliVersion !== undefined && (typeof cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(cliVersion))) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid activation evidence");
  }
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    requireClaimedAttempt(current, attemptId, identity);
    if (current.phase !== "DISPATCHING" || !["estimated_activation", "manual_test", "activity_wake"].includes(current.attempt.kind) ||
        current.attempt.configGeneration !== current.configGeneration || current.credentialUpdate !== null ||
        current.credentialGeneration !== (current.attempt.committedGeneration ?? current.attempt.credentialGeneration)) {
      throw new Error("Activation is not authorized");
    }
    if (current.attempt.kind === "manual_test") {
      if (current.config.autoEnabled !== false) throw new Error("Manual test requires automatic activation disabled");
    } else if (current.attempt.kind === "activity_wake") {
      const wake = planWakes(current, nowMs, "reserved").candidates.find((item) => item.key === current.attempt.windowKey);
      const expectedTag = current.activityWake?.accountTag;
      if (!activityWakesEnabled || !wake || nowMs < wake.dueAtMs || !evaluateSchedule(current.config, new Date(nowMs)).permitted ||
          !/^[a-f0-9]{64}$/.test(accountTag ?? "") || (expectedTag && expectedTag !== accountTag)) {
        throw new Error("Activity wake is no longer eligible");
      }
    } else {
      const due = evaluateConservativeWindow({ config: current.config, estimate: current.conservativeEstimate,
        acknowledged: current.conservativeAcknowledged, nowMs });
      if (!due.candidate) throw new Error(`Activation no longer permitted: ${due.reason}`);
      if (current.estimatedRetry && (!Number.isSafeInteger(current.estimatedRetry.notBeforeMs) || nowMs < current.estimatedRetry.notBeforeMs)) {
        throw new Error("Retry interval not reached");
      }
    }
    if (current.config.model === null) throw new Error("A verified model must be selected");
    const attestation = current.modelAttestation;
    const validLocalAttestation = cliVersion !== undefined && isLocallyAttested(attestation, current.config.model, nowMs, cliVersion);
    const selected = selectModel({ models: models.length ? models : validLocalAttestation ? [{ id: attestation.model }] : [],
      selectedModel: current.config.model, nowMs });
    if (selected.outcome !== "selected" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selected.model)) {
      throw new Error("Selected model is not currently available");
    }
    const next = { ...current, revision: current.revision + 1, phase: "ACTIVATING",
      attempt: { ...current.attempt, permitIssuedAtMs: nowMs },
      ...(current.attempt.kind === "activity_wake"
        ? { ...consumeWake(current, current.attempt.wake ?? { source: "user_activity" }, "permit_issued"),
          idleWakes: (current.idleWakes ?? 0) + 1 } : {}) };
    await tx.put(STATE_KEY, next);
    return { state: next, model: selected.model, message: current.config.activationMessage };
  });
}

function normalizeActivationSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  if (typeof snapshot !== "object" || Array.isArray(snapshot) ||
      Object.keys(snapshot).sort().join(",") !== "limitId,observedAtMs,resetAtMs,source,usedPercent,windowDurationMins" ||
      snapshot.source !== "account/rateLimits/read" || typeof snapshot.limitId !== "string" || !snapshot.limitId || snapshot.limitId.length > 200 ||
      snapshot.windowDurationMins !== 300 || !Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs < 0 ||
      !Number.isSafeInteger(snapshot.resetAtMs) || snapshot.resetAtMs < snapshot.observedAtMs ||
      typeof snapshot.usedPercent !== "number" || !Number.isFinite(snapshot.usedPercent) || snapshot.usedPercent < 0 || snapshot.usedPercent > 100) {
    throw new Error("Invalid activation quota snapshot");
  }
  return { source: snapshot.source, limitId: snapshot.limitId, windowDurationMins: snapshot.windowDurationMins,
    observedAtMs: snapshot.observedAtMs, resetAtMs: snapshot.resetAtMs, usedPercent: snapshot.usedPercent };
}

// A successful CLI exit remains unverified. A failed or ambiguous invocation
// is durably blocked instead of retried. Credential persistence must finish
// first, even if the administrator disabled the service while it was running.
export async function completeEstimatedActivation(storage, { attemptId, identity, outcome, startedAtMs, finishedAtMs, beforeSnapshot, afterSnapshot, nowMs }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId) || !identity ||
      typeof identity.runId !== "string" || !/^[1-9]\d*$/.test(identity.runId) || identity.runAttempt !== "1" ||
      !["completed_unverified", "not_started", "unconfirmed"].includes(outcome) ||
      ![startedAtMs, finishedAtMs, nowMs].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid activation report");
  }
  const before = normalizeActivationSnapshot(beforeSnapshot);
  const after = normalizeActivationSnapshot(afterSnapshot);
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    const report = { attemptId, runId: identity.runId, runAttempt: identity.runAttempt, outcome, startedAtMs, finishedAtMs,
      beforeSnapshot: before, afterSnapshot: after };
    if (current.lastActivation?.attemptId === attemptId && current.lastActivation.runId === identity.runId &&
        current.lastActivation.runAttempt === identity.runAttempt) {
      if (Object.keys(report).every((key) => JSON.stringify(current.lastActivation[key]) === JSON.stringify(report[key]))) return current;
      throw new Error("Activation report conflicts with the previous result");
    }
    if ([before, after].some((snapshot) => snapshot &&
        (snapshot.observedAtMs > nowMs + 30000 || nowMs - snapshot.observedAtMs > 30 * 60 * 1000))) {
      throw new Error("Activation quota snapshot is stale");
    }
    requireClaimedAttempt(current, attemptId, identity);
    if (current.phase !== "ACTIVATING" || current.credentialUpdate !== null ||
        current.credentialGeneration !== (current.attempt.committedGeneration ?? current.attempt.credentialGeneration)) {
      throw new Error("Activation or credential status is unconfirmed");
    }
    if (startedAtMs + 30000 < current.attempt.permitIssuedAtMs) throw new Error("Activation predates permission");
    // Validate timing on all paths, including failures, before persisting.
    const validatedTiming = nextConservativeWindow({ startedAtMs, finishedAtMs, reportedAtMs: nowMs,
      marginMs: current.conservativeEstimate?.marginMs });
    let next;
    if (outcome === "completed_unverified") {
      const source = current.attempt.wake?.source ?? "user_activity";
      const canContinue = current.attempt.kind === "activity_wake" && source !== "appointment" &&
        current.config.autoEnabled && current.attempt.configGeneration === current.configGeneration &&
        (current.activityCutoffMs ?? 0) < current.attempt.permitIssuedAtMs &&
        (current.activityWake?.observedAtMs ?? 0) <= current.attempt.permitIssuedAtMs;
      const estimate = Math.max(finishedAtMs, nowMs) + WINDOW_MS;
      next = { ...current, revision: current.revision + 1, phase: "WAITING", attempt: null, lastActivation: report, lastWakeReportedAtMs: nowMs,
        ...(current.attempt.kind === "activity_wake"
          ? { lastActivityWake: { ...report, windowKey: current.attempt.windowKey, source },
            continuation: canContinue ? { source: "rolling", key: `rolling:${attemptId}`,
              dueAtMs: estimate + ACTIVITY_GRACE_MS, expiresAtMs: estimate + WAKE_TTL_MS } : null }
          : { conservativeEstimate: validatedTiming, estimatedRetry: null }) };
    } else if (current.attempt.kind === "estimated_activation" && outcome === "not_started" && (current.estimatedRetry?.count ?? 0) < current.config.maxRetries) {
      const retryAt = nowMs + current.config.retryIntervalMinutes * 60000;
      if (!Number.isSafeInteger(retryAt)) throw new Error("Invalid retry interval");
      next = { ...current, revision: current.revision + 1, phase: "WAITING", attempt: null, lastActivation: report,
        estimatedRetry: { anchorMs: current.conservativeEstimate.anchorMs, count: (current.estimatedRetry?.count ?? 0) + 1, notBeforeMs: retryAt } };
    } else {
      next = { ...current, revision: current.revision + 1, phase: "FAILED", lastActivation: report,
        ...(current.attempt.kind === "activity_wake"
          ? { lastActivityWake: { ...report, windowKey: current.attempt.windowKey, source: current.attempt.wake?.source ?? "user_activity" } } : {}) };
    }
    await tx.put(STATE_KEY, next);
    return next;
  });
}

// At-most-one notification attempt per successful CLI completion. Mark before
// the external HTTP call; a lost response is not retried automatically.
export async function reserveSuccessNotification(storage, { attemptId }) {
  if (typeof attemptId !== "string" || !UUID.test(attemptId)) throw new Error("Invalid notification attempt");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.config.notifySuccess !== true || current.lastActivation?.attemptId !== attemptId ||
        current.lastActivation.outcome !== "completed_unverified" || current.lastNotificationAttempt === attemptId) {
      return { state: current, reserved: false };
    }
    const next = { ...current, revision: current.revision + 1, lastNotificationAttempt: attemptId };
    await tx.put(STATE_KEY, next);
    return { state: next, reserved: true };
  });
}

// Caller must independently verify that this exact GitHub run completed.
// Clearing the generation forces a new isolated login/bootstrap; it never
// reuses a potentially stale token from a crashed Runner.
export async function resetAfterCompletedRun(storage, { expectedRevision, attemptId, runId, nowMs }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof attemptId !== "string" || !UUID.test(attemptId) ||
      typeof runId !== "string" || !/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid recovery");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision || !["DISPATCHING", "ACTIVATING", "FAILED"].includes(current.phase) ||
        current.attempt.id !== attemptId || current.attempt.dispatch.outcome !== "accepted" || current.attempt.dispatch.runId !== runId ||
        current.credentialUpdate !== null || current.credentialBootstrap !== null) throw new Error("Run recovery is unsafe");
    const next = { ...current, revision: current.revision + 1, configGeneration: current.configGeneration + 1,
      phase: "WAITING", attempt: null, config: { ...current.config, autoEnabled: false }, credentialGeneration: null,
      activityCutoffMs: nowMs, activityWake: canceledActivity(current, "recovery"), continuation: null, idleWakes: 0,
      conservativeAcknowledged: false, conservativeEstimate: null, modelAttestation: null, quotaSnapshot: null, lastProbe: null,
      estimatedRetry: null,
      lastRecovery: { attemptId, runId, recoveredAtMs: nowMs, reauthenticationRequired: true } };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function readState(storage) {
  return validateStoredState((await storage.get(STATE_KEY)) ?? initialState());
}

// The caller must authenticate and authorize the operator before invoking this
// method. It is intentionally not exposed by any HTTP route yet.
export async function replaceConfig(storage, config, expectedRevision, nowMs = Date.now()) {
  const nextConfig = validateConfig(config);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid expected revision");
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    if (current.credentialBootstrap !== null && nextConfig.autoEnabled) throw new Error("Credential bootstrap is pending");
    const pending = current.phase === "DISPATCHING" && current.attempt?.wake
      ? current.attempt.wake : planWakes(current, nowMs).candidates[0];
    const next = {
      ...current,
      revision: current.revision + 1,
      configGeneration: current.configGeneration + 1,
      config: nextConfig,
      ...(current.config.autoEnabled && !nextConfig.autoEnabled && pending?.source === "appointment"
        ? consumeWake(current, pending, "paused") : {}),
      ...(nextConfig.autoEnabled === false || current.config.autoEnabled === false
        ? { activityCutoffMs: nowMs, activityWake: canceledActivity(current, "disabled"), continuation: null } : {}),
    };
    await tx.put(STATE_KEY, next);
    return next;
  });
}

export async function replaceAppointments(storage, { appointments, expectedRevision, nowMs }) {
  const items = validateAppointments(appointments, nowMs);
  return storage.transaction(async (tx) => {
    const current = await readState(tx);
    if (current.revision !== expectedRevision) throw new Error("State revision conflict");
    const usedAppointments = Object.fromEntries(items.filter(({ id }) => Object.hasOwn(current.usedAppointments ?? {}, id))
      .map(({ id }) => [id, current.usedAppointments[id]]));
    const next = { ...current, appointments: items, usedAppointments, revision: current.revision + 1,
      configGeneration: current.configGeneration + 1 };
    await tx.put(STATE_KEY, next);
    return next;
  });
}
