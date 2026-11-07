import { evaluateEligibility } from "./eligibility.mjs";
import { dispatchWorkflow } from "./github-dispatch.mjs";
import { readState, recordDispatchOutcome, reservePreflight, reserveManualProbe, reserveManualTest, reserveActivityWake } from "./state.mjs";

async function performDispatch(storage, { githubConfig, attemptId }, dispatch) {
  let result;
  try { result = await dispatch({ ...githubConfig, attemptId }); }
  catch { result = { outcome: "unknown" }; }
  const validAccepted = result?.outcome === "accepted" && typeof result.runId === "string" && /^[1-9]\d*$/.test(result.runId);
  const outcome = validAccepted ? "accepted" : result?.outcome === "rejected" ? "rejected" : "unknown";
  const runId = validAccepted ? result.runId : null;
  const httpStatus = Number.isSafeInteger(result?.status) && result.status >= 100 && result.status <= 599 ? result.status : null;
  // If this write fails the persisted reservation remains in place. Do not
  // clear it or retry dispatch; the GitHub request may have succeeded.
  await recordDispatchOutcome(storage, { attemptId, outcome, runId, httpStatus });
  return { outcome, attemptId, ...(runId ? { runId } : {}), ...(httpStatus === null ? {} : { httpStatus }) };
}

// Not wired into Cron yet. An accepted response authorizes only a preflight;
// the Runner must still authenticate, claim the matching run and check quota.
// nowMs and attemptId are coordinator-generated, never supplied by a caller.
export async function dispatchDuePreflight(storage, { githubConfig, nowMs, attemptId }, options = {}) {
  const state = await readState(storage);
  if (state.phase !== "WAITING") return { outcome: "skipped", reason: "in_flight" };
  const eligibility = evaluateEligibility({ config: state.config, now: new Date(nowMs), snapshot: state.quotaSnapshot });
  if (!eligibility.candidate) return { outcome: "skipped", reason: eligibility.reason };
  if (!state.credentialGeneration) return { outcome: "skipped", reason: "credentials_missing" };
  try {
    await reservePreflight(storage, { attemptId, expectedRevision: state.revision, nowMs });
  } catch (error) {
    if (error?.message === "State revision conflict" || error?.message === "A preflight is already in progress") {
      // No HTTP request has been made. Let the next Cron tick re-evaluate.
      return { outcome: "skipped", reason: "reservation_conflict" };
    }
    throw error;
  }
  return performDispatch(storage, { githubConfig, attemptId }, options.dispatch ?? dispatchWorkflow);
}

// Call only after authenticating an explicit administrator request. This is a
// probe, not an authorization to activate or to bypass the credential lock.
export async function dispatchManualProbe(storage, { githubConfig, nowMs, attemptId, expectedRevision }, options = {}) {
  await reserveManualProbe(storage, { attemptId, expectedRevision, nowMs });
  return performDispatch(storage, { githubConfig, attemptId }, options.dispatch ?? dispatchWorkflow);
}

export async function dispatchManualTest(storage, { githubConfig, nowMs, attemptId, expectedRevision }, options = {}) {
  await reserveManualTest(storage, { attemptId, expectedRevision, nowMs });
  return performDispatch(storage, { githubConfig, attemptId }, options.dispatch ?? dispatchWorkflow);
}

export async function dispatchActivityWake(storage, { githubConfig, attemptId, expectedRevision, nowMs }, options = {}) {
  const { reason } = await reserveActivityWake(storage, { attemptId, expectedRevision, nowMs });
  if (reason) return { outcome: "skipped", reason };
  return performDispatch(storage, { githubConfig, attemptId }, options.dispatch ?? dispatchWorkflow);
}
