// Test-only Worker. This has deliberately unauthenticated fixture endpoints;
// never use this module as a production entry point.
import { STATE_KEY, readState, replaceConfig, reservePreflight, reserveManualProbe, claimPreflight, recordDispatchOutcome, completePreflight,
  prepareCredentialRotation, commitCredentialRotation, authorizeCredentialWrite, enrollConservativeMode, reserveEstimatedActivation,
  authorizeEstimatedActivation, completeEstimatedActivation, reserveManualTest, recordLocalActivity, reserveActivityWake, cancelActivityWake, skipActivityWake, replaceAppointments } from "../src/state.mjs";

export class TestCoordinator {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const { operation, config, revision, state, args } = await request.json();
    try {
      if (operation === "local-activity") return Response.json(await recordLocalActivity(this.storage, args.event, args.nowMs, true));
      if (operation === "appointments") return Response.json(await replaceAppointments(this.storage, args));
      if (operation === "reserve-activity") return Response.json(await reserveActivityWake(this.storage, args));
      if (operation === "cancel-activity") return Response.json(await cancelActivityWake(this.storage, args));
      if (operation === "skip-activity") return Response.json(await skipActivityWake(this.storage, args));
      if (operation === "read") return Response.json(await readState(this.storage));
      if (operation === "replace") return Response.json(await replaceConfig(this.storage, config, revision));
      if (operation === "seed") { await this.storage.put(STATE_KEY, state); return Response.json({ ok: true }); }
      if (operation === "reserve") return Response.json(await reservePreflight(this.storage, args));
      if (operation === "manual-reserve") return Response.json(await reserveManualProbe(this.storage, args));
      if (operation === "dispatch-outcome") return Response.json(await recordDispatchOutcome(this.storage, args));
      if (operation === "claim") return Response.json(await claimPreflight(this.storage, args));
      if (operation === "prepare") return Response.json(await prepareCredentialRotation(this.storage, args));
      if (operation === "authorize-write") return Response.json(await authorizeCredentialWrite(this.storage, args));
      if (operation === "commit") return Response.json(await commitCredentialRotation(this.storage, args));
      if (operation === "complete") return Response.json(await completePreflight(this.storage, args));
      if (operation === "enroll-estimate") return Response.json(await enrollConservativeMode(this.storage, args));
      if (operation === "reserve-estimate") return Response.json(await reserveEstimatedActivation(this.storage, args));
      if (operation === "reserve-manual-test") return Response.json(await reserveManualTest(this.storage, args));
      if (operation === "authorize-activation") return Response.json(await authorizeEstimatedActivation(this.storage, args));
      if (operation === "complete-activation") return Response.json(await completeEstimatedActivation(this.storage, args));
      return new Response("Not found", { status: 404 });
    } catch { return Response.json({ error: "rejected" }, { status: 409 }); }
  }
}

export default {
  fetch(request, env) { return env.TEST_OBJECT.get(env.TEST_OBJECT.idFromName("test")).fetch(request); },
};
