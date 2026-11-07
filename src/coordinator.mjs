import { planWakes } from "./wake-planning.mjs";
import { activityEnabled, ACTIVITY_BLOCK, ACTIVITY_GRACE_MS, WAKE_TTL_MS, evaluateActivityWake } from "./activity-policy.mjs";
import { evaluateSchedule } from "./policy.mjs";
import { claimPreflight, readState, replaceConfig, prepareCredentialRotation, commitCredentialRotation, completePreflight,
  prepareCredentialBootstrap, commitCredentialBootstrap, authorizeBootstrapWrite, authorizeCredentialWrite,
  authorizeEstimatedActivation, completeEstimatedActivation, enrollConservativeMode, attestLocalModelCatalog, reserveSuccessNotification,
  resetAfterCompletedRun, releaseRejectedManualTest, recordLocalActivity, cancelActivityWake, skipActivityWake, replaceAppointments } from "./state.mjs";
import { dispatchManualProbe, dispatchManualTest, dispatchActivityWake } from "./dispatch-orchestrator.mjs";
import { validateDispatchConfig } from "./github-dispatch.mjs";
import { validateSuccessWebhook, sendSuccessNotification } from "./notify.mjs";
import { verifyCompletedGitHubRun } from "./recovery.mjs";
import { mirrorStatusToKv } from "./status-mirror.mjs";
import { isLocallyAttested } from "./model-selection.mjs";

function activationDispatchConfig(env) {
  const githubConfig = { owner: env.GITHUB_DISPATCH_OWNER, repo: env.GITHUB_DISPATCH_REPO,
    workflow: "wake.yml", ref: env.GITHUB_OIDC_REF, token: env.GITHUB_ACTIONS_WRITE_TOKEN };
  validateDispatchConfig(githubConfig);
  const expectedWorkflow = `${githubConfig.owner}/${githubConfig.repo}/.github/workflows/wake.yml@${githubConfig.ref}`;
  if (env.GITHUB_OIDC_WORKFLOW_REF !== expectedWorkflow || !/^[1-9]\d*$/.test(env.GITHUB_OIDC_REPOSITORY_ID ?? "") ||
      !/^[1-9]\d*$/.test(env.GITHUB_OIDC_OWNER_ID ?? "") || !/^[a-f0-9]{40}$/i.test(env.GITHUB_OIDC_WORKFLOW_SHA ?? "") ||
      typeof env.GITHUB_OIDC_AUDIENCE !== "string" || !env.GITHUB_OIDC_AUDIENCE) throw new Error("Incomplete activation configuration");
  return githubConfig;
}

// Durable Object is the single writer of authoritative state. Automatic
// dispatch remains disabled; the explicit manual probe has a separate gate.
export class Coordinator {
  constructor(state, env = {}, options = {}) {
    this.state = state;
    this.env = env;
    this.dispatch = options.dispatch;
    this.notify = options.notify ?? sendSuccessNotification;
    this.verifyRun = options.verifyRun ?? verifyCompletedGitHubRun;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // These routes are reachable only via the Worker binding. The Worker must
    // authenticate the administrator before forwarding a request.
    if (request.method === "GET" && url.pathname === "/status") {
      const state = await readState(this.state.storage);
      const model = state.modelAttestation;
      const modelAttestation = model ? { source: model.source, model: model.model, cliVersion: model.cliVersion, verifiedAtMs: model.verifiedAtMs } : null;
      const activityAvailable = activityEnabled(this.env);
      const automaticBlockReason = !activityAvailable ? ACTIVITY_BLOCK
        : !state.credentialGeneration || state.credentialUpdate !== null || state.credentialBootstrap !== null ? "credentials_unavailable"
          : !isLocallyAttested(model, state.config.model, Date.now()) ? "model_attestation_missing" : null;
      const plan = planWakes(state, Date.now(), state.activityWake?.status === "reserved" ? "reserved" : "armed");
      const wakePlan = { ...plan, idleWakes: state.idleWakes ?? 0,
        pending: plan.candidates[0] ?? null };
      delete wakePlan.candidates;
      return Response.json({ wakePlan, phase: state.phase, revision: state.revision, configGeneration: state.configGeneration,
        config: state.config, dispatchOutcome: state.attempt?.dispatch?.outcome ?? null,
        automaticBlockReason,
        activityWake: state.activityWake ? { status: state.activityWake.status, source: state.activityWake.eventKind,
          activityAtMs: state.activityWake.activityAtMs, observedAtMs: state.activityWake.observedAtMs,
          usedPercent: state.activityWake.usedPercent, resetAtMs: state.activityWake.resetAtMs,
          dueAtMs: state.activityWake.resetAtMs + ACTIVITY_GRACE_MS, expiresAtMs: state.activityWake.resetAtMs + WAKE_TTL_MS,
          reason: state.activityWake.status === "armed"
            ? evaluateActivityWake(state, Date.now()) : state.activityWake.reason } : null,
        lastActivityWake: state.lastActivityWake ?? null, lastSkippedWake: state.lastSkippedWake ?? null,
        credentialGeneration: state.credentialGeneration, credentialUpdatePending: state.credentialUpdate !== null, credentialBootstrap: state.credentialBootstrap,
        quotaSnapshot: state.quotaSnapshot, conservativeEstimate: state.conservativeEstimate ?? null,
        conservativeAcknowledged: state.conservativeAcknowledged === true, modelAttestation,
        lastActivation: state.lastActivation ?? null, lastRecovery: state.lastRecovery ?? null, estimatedRetry: state.estimatedRetry ?? null,
        credentialUpdateWriteState: state.credentialUpdate?.writeState ?? null,
        currentAttempt: state.attempt ? { id: state.attempt.id, kind: state.attempt.kind, runId: state.attempt.dispatch.runId,
          dispatchOutcome: state.attempt.dispatch.outcome, httpStatus: state.attempt.dispatch.httpStatus ?? null } : null });
    }
    if (request.method === "POST" && url.pathname === "/local-activity") {
      try {
        const { state, outcome } = await recordLocalActivity(this.state.storage, await request.json(), Date.now(), activityEnabled(this.env));
        return Response.json({ revision: state.revision, outcome });
      } catch { return Response.json({ error: "activity rejected" }, { status: 409 }); }
    }
    if (request.method === "PUT" && url.pathname === "/appointments") {
      try {
        const state = await replaceAppointments(this.state.storage, { ...await request.json(), nowMs: Date.now() });
        return Response.json({ revision: state.revision });
      } catch { return Response.json({ error: "appointments rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/cancel-wake") {
      try {
        const state = await cancelActivityWake(this.state.storage, { ...await request.json(), nowMs: Date.now() });
        return Response.json({ revision: state.revision, permitAlreadyIssued: state.phase === "ACTIVATING" });
      } catch { return Response.json({ error: "cancel rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/release-rejected-test") {
      try {
        const next = await releaseRejectedManualTest(this.state.storage, await request.json());
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "rejected test release unavailable" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/recover") {
      try {
        const { expectedRevision, confirmed } = await request.json();
        if (confirmed !== true || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid recovery request");
        const state = await readState(this.state.storage);
        const runId = state.attempt?.dispatch?.runId;
        if (state.revision !== expectedRevision || state.attempt?.dispatch?.outcome !== "accepted" || !runId || state.credentialUpdate !== null) {
          throw new Error("Recovery not permitted");
        }
        const githubConfig = activationDispatchConfig(this.env);
        const completed = await this.verifyRun({ githubConfig, runId, repositoryId: this.env.GITHUB_OIDC_REPOSITORY_ID,
          workflowSha: this.env.GITHUB_OIDC_WORKFLOW_SHA });
        if (!completed) throw new Error("GitHub run is not confirmed complete");
        const next = await resetAfterCompletedRun(this.state.storage, { expectedRevision, attemptId: state.attempt.id, runId, nowMs: Date.now() });
        return Response.json({ revision: next.revision, reauthenticationRequired: true });
      } catch { return Response.json({ error: "recovery unavailable" }, { status: 409 }); }
    }
    if (request.method === "POST" && ["/conservative/enroll", "/model-catalog"].includes(url.pathname)) {
      if (this.env.ACTIVATION_ENABLED !== "true") return Response.json({ error: "activation disabled" }, { status: 503 });
      try {
        const body = await request.json();
        const next = url.pathname === "/conservative/enroll"
          ? await enrollConservativeMode(this.state.storage, { ...body, nowMs: Date.now() })
          : await attestLocalModelCatalog(this.state.storage, { ...body, nowMs: Date.now() });
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "activation setup rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && ["/bootstrap/prepare", "/bootstrap/authorize-write", "/bootstrap/commit"].includes(url.pathname)) {
      try {
        const body = await request.json();
        const next = url.pathname === "/bootstrap/prepare" ? await prepareCredentialBootstrap(this.state.storage, body)
          : url.pathname === "/bootstrap/authorize-write" ? await authorizeBootstrapWrite(this.state.storage, body)
          : await commitCredentialBootstrap(this.state.storage, body);
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "credential bootstrap rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/manual-probe") {
      if (this.env.PROBE_DISPATCH_ENABLED !== "true") return Response.json({ error: "manual probe disabled" }, { status: 503 });
      const githubConfig = { owner: this.env.GITHUB_DISPATCH_OWNER, repo: this.env.GITHUB_DISPATCH_REPO,
        workflow: "probe.yml", ref: this.env.GITHUB_OIDC_REF, token: this.env.GITHUB_ACTIONS_WRITE_TOKEN };
      try {
        validateDispatchConfig(githubConfig);
        const expectedWorkflow = `${githubConfig.owner}/${githubConfig.repo}/.github/workflows/probe.yml@${githubConfig.ref}`;
        if (this.env.GITHUB_OIDC_WORKFLOW_REF !== expectedWorkflow ||
            !/^[1-9]\d*$/.test(this.env.GITHUB_OIDC_REPOSITORY_ID ?? "") || !/^[1-9]\d*$/.test(this.env.GITHUB_OIDC_OWNER_ID ?? "") ||
            !/^[a-f0-9]{40}$/i.test(this.env.GITHUB_OIDC_WORKFLOW_SHA ?? "") ||
            typeof this.env.GITHUB_OIDC_AUDIENCE !== "string" || !this.env.GITHUB_OIDC_AUDIENCE) {
          return Response.json({ error: "manual probe configuration incomplete" }, { status: 503 });
        }
      } catch { return Response.json({ error: "manual probe configuration incomplete" }, { status: 503 }); }
      try {
        const { expectedRevision } = await request.json();
        const result = await dispatchManualProbe(this.state.storage, { githubConfig, expectedRevision,
          attemptId: crypto.randomUUID(), nowMs: Date.now() }, { dispatch: this.dispatch });
        return Response.json({ ...result, revision: (await readState(this.state.storage)).revision });
      } catch { return Response.json({ error: "manual probe rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/manual-wake") {
      if (this.env.ACTIVATION_ENABLED !== "true") return Response.json({ error: "activation disabled" }, { status: 503 });
      try {
        const { expectedRevision } = await request.json();
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid revision");
        const githubConfig = activationDispatchConfig(this.env);
        const result = activityEnabled(this.env)
          ? await dispatchActivityWake(this.state.storage, { githubConfig, expectedRevision,
            nowMs: Date.now(), attemptId: crypto.randomUUID() }, { dispatch: this.dispatch })
          : { outcome: "skipped", reason: ACTIVITY_BLOCK };
        return Response.json({ ...result, revision: (await readState(this.state.storage)).revision });
      } catch { return Response.json({ error: "manual activation rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/manual-test") {
      if (this.env.ACTIVATION_ENABLED !== "true") return Response.json({ error: "activation disabled" }, { status: 503 });
      try {
        const { expectedRevision } = await request.json();
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid revision");
        const state = await readState(this.state.storage);
        if (!isLocallyAttested(state.modelAttestation, state.config.model, Date.now())) throw new Error("Model attestation missing");
        const githubConfig = activationDispatchConfig(this.env);
        const result = await dispatchManualTest(this.state.storage, { githubConfig, expectedRevision,
          nowMs: Date.now(), attemptId: crypto.randomUUID() }, { dispatch: this.dispatch });
        return Response.json({ ...result, revision: (await readState(this.state.storage)).revision });
      } catch { return Response.json({ error: "manual test rejected" }, { status: 409 }); }
    }
    if (request.method === "PUT" && url.pathname === "/config") {
      try {
        const { config, expectedRevision } = await request.json();
        if (config?.notifySuccess === true) validateSuccessWebhook(this.env.SUCCESS_WEBHOOK_URL);
        if (config?.autoEnabled === true) {
          if (!activityEnabled(this.env)) throw new Error(ACTIVITY_BLOCK);
          activationDispatchConfig(this.env);
          const current = await readState(this.state.storage);
          if (!current.credentialGeneration || current.credentialUpdate !== null || current.credentialBootstrap !== null ||
              !isLocallyAttested(current.modelAttestation, config.model, Date.now())) {
            throw new Error("Wake credentials or model are not configured");
          }
          if (!current.config.autoEnabled && current.phase !== "WAITING") throw new Error("Coordinator is busy");
        } else if (config?.autoEnabled !== false) throw new Error("Invalid automatic switch");
        const state = await replaceConfig(this.state.storage, config, expectedRevision);
        return Response.json({ revision: state.revision, configGeneration: state.configGeneration });
      } catch { return Response.json({ error: "configuration rejected" }, { status: 409 }); }
    }
    // The public Worker verifies GitHub OIDC before forwarding this internal
    // request. The Durable Object binding is never exposed directly.
    if (request.method === "POST" && url.pathname === "/claim") {
      try {
        const body = await request.json();
        const next = await claimPreflight(this.state.storage, { ...body, nowMs: Date.now() });
        return Response.json({ revision: next.revision, kind: next.attempt.kind });
      } catch { return Response.json({ error: "claim rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && ["/activation/authorize", "/activation/complete", "/activation/skip"].includes(url.pathname)) {
      if (this.env.ACTIVATION_ENABLED !== "true") return Response.json({ error: "activation disabled" }, { status: 503 });
      try {
        const body = await request.json();
        if (url.pathname === "/activation/skip") {
          const state = await skipActivityWake(this.state.storage, body);
          return Response.json({ revision: state.revision });
        }
        if (url.pathname === "/activation/authorize") {
          const current = await readState(this.state.storage);
          if (!["manual_test", "activity_wake"].includes(current.attempt?.kind)) throw new Error("Legacy activation is disabled");
          const result = await authorizeEstimatedActivation(this.state.storage, { ...body, activityWakesEnabled: activityEnabled(this.env), nowMs: Date.now() });
          return Response.json({ revision: result.state.revision, model: result.model, message: result.message });
        }
        let next = await completeEstimatedActivation(this.state.storage, { ...body, nowMs: Date.now() });
        if (body.outcome === "completed_unverified" && next.config.notifySuccess && this.env.SUCCESS_WEBHOOK_URL) {
          const notification = await reserveSuccessNotification(this.state.storage, { attemptId: body.attemptId });
          next = notification.state;
          if (notification.reserved) {
            try { await this.notify({ url: this.env.SUCCESS_WEBHOOK_URL, finishedAtMs: body.finishedAtMs }); }
            catch { /* Notification failure never repeats the model request. */ }
          }
        }
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "activation rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && ["/credential/prepare", "/credential/authorize-write", "/credential/commit"].includes(url.pathname)) {
      try {
        const body = await request.json();
        const next = url.pathname === "/credential/prepare" ? await prepareCredentialRotation(this.state.storage, body)
          : url.pathname === "/credential/authorize-write" ? await authorizeCredentialWrite(this.state.storage, body)
          : await commitCredentialRotation(this.state.storage, body);
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "credential update rejected" }, { status: 409 }); }
    }
    if (request.method === "POST" && url.pathname === "/probe/complete") {
      try {
        const body = await request.json();
        const next = await completePreflight(this.state.storage, { ...body, nowMs: Date.now() });
        return Response.json({ revision: next.revision });
      } catch { return Response.json({ error: "probe report rejected" }, { status: 409 }); }
    }
    if (request.method !== "POST" || url.pathname !== "/tick") {
      return new Response("Not found", { status: 404 });
    }
    const state = await readState(this.state.storage);
    const schedule = evaluateSchedule(state.config, new Date());
    if (this.env.ACTIVATION_ENABLED !== "true" || state.config.autoEnabled !== true) {
      await mirrorStatusToKv(this.state.storage, this.env.STATE_SNAPSHOTS);
      return Response.json({ state: state.phase, revision: state.revision, schedule, dispatchImplemented: this.env.ACTIVATION_ENABLED === "true" });
    }
    try {
      const githubConfig = activationDispatchConfig(this.env);
      const result = activityEnabled(this.env)
        ? await dispatchActivityWake(this.state.storage, { githubConfig, nowMs: Date.now(), attemptId: crypto.randomUUID() }, { dispatch: this.dispatch })
        : { outcome: "skipped", reason: ACTIVITY_BLOCK };
      await mirrorStatusToKv(this.state.storage, this.env.STATE_SNAPSHOTS);
      return Response.json({ state: state.phase, revision: state.revision, schedule, result });
    } catch { return Response.json({ error: "activation dispatch unavailable" }, { status: 503 }); }
  }
}
