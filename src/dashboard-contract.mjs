import { validateConfig } from "./policy.mjs";

export const dashboardFields = ["timeZone", "allowedStart", "allowedEnd", "sleepStart", "sleepEnd",
  "activationMessage", "model", "notifySuccess", "autoEnabled", "maxIdleWakes"];

export function dashboardStatus(cloud) {
  const { revision, phase, config, activityWake, currentAttempt, modelAttestation, lastActivityWake, lastActivation, wakePlan } = cloud;
  const result = (wake) => wake ? { outcome: wake.outcome, finishedAtMs: wake.finishedAtMs, source: wake.source } : null;
  return {
    revision, phase, config: validateConfig(config), automaticBlockReason: cloud.automaticBlockReason ?? null,
    verifiedModel: modelAttestation?.model ?? null,
    activityWake: activityWake ?? null, currentAttempt: currentAttempt ? { kind: currentAttempt.kind, dispatchOutcome: currentAttempt.dispatchOutcome } : null,
    lastActivityWake: result(lastActivityWake), lastActivation: result(lastActivation), wakePlan: wakePlan ?? null,
  };
}

export function dashboardConfig(settings, current) {
  // Older opened tabs may omit the newly introduced rolling limit.
  const fields = dashboardFields.filter((name) => name !== "maxIdleWakes" || Object.hasOwn(settings ?? {}, name));
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).length !== fields.length || fields.some((name) => !Object.hasOwn(settings, name))) {
    throw new Error("Invalid dashboard settings");
  }
  return validateConfig({ ...current, ...settings });
}
