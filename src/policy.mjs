// Scheduling only. A permitted time is NOT proof that a quota window ended.
export const DEFAULT_CONFIG = Object.freeze({
  autoEnabled: false,
  maxIdleWakes: 2,
  timeZone: "Asia/Hong_Kong",
  allowedStart: "08:00",
  allowedEnd: "23:00",
  sleepStart: "23:00",
  sleepEnd: "08:00",
  activationMessage: "hello",
  model: null,
  maxRetries: 2,
  retryIntervalMinutes: 15,
  notifySuccess: false,
});

function minutes(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error("Expected time in HH:mm format");
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

// Start is inclusive; end is exclusive. Equal endpoints are invalid.
function inInterval(current, startText, endText) {
  const start = minutes(startText);
  const end = minutes(endText);
  if (start === end) throw new Error("Interval endpoints must differ");
  return start < end ? current >= start && current < end : current >= start || current < end;
}

// Validate before persisting configuration. Unknown keys are rejected so a
// misspelled safety setting cannot silently leave an unintended default.
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Configuration must be an object");
  }
  const keys = Object.keys(DEFAULT_CONFIG);
  if (Object.keys(config).some((key) => !keys.includes(key)) || keys.some((key) => key !== "maxIdleWakes" && !Object.hasOwn(config, key))) {
    throw new Error("Configuration keys do not match the schema");
  }
  if (typeof config.autoEnabled !== "boolean" || typeof config.notifySuccess !== "boolean") {
    throw new Error("Switches must be booleans");
  }
  if (typeof config.timeZone !== "string" || !config.timeZone) throw new Error("Time zone is required");
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.timeZone });
  } catch {
    throw new Error("Unknown IANA time zone");
  }
  inInterval(0, config.allowedStart, config.allowedEnd);
  inInterval(0, config.sleepStart, config.sleepEnd);
  if (typeof config.activationMessage !== "string" || !config.activationMessage.trim() || config.activationMessage.length > 1000) {
    throw new Error("Activation message must be between 1 and 1000 characters");
  }
  if (config.model !== null && (typeof config.model !== "string" || !config.model.trim() || config.model.length > 200)) {
    throw new Error("Model must be null or a non-empty model ID");
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10) {
    throw new Error("Maximum retries must be an integer between 0 and 10");
  }
  if (!Number.isInteger(config.retryIntervalMinutes) || config.retryIntervalMinutes < 1 || config.retryIntervalMinutes > 1440) {
    throw new Error("Retry interval must be between 1 and 1440 minutes");
  }
  const maxIdleWakes = Object.hasOwn(config, "maxIdleWakes") ? config.maxIdleWakes : DEFAULT_CONFIG.maxIdleWakes;
  if (!Number.isInteger(maxIdleWakes) || maxIdleWakes < 1 || maxIdleWakes > 12) throw new Error("Invalid consecutive wake limit");
  return { ...config, maxIdleWakes };
}

export function evaluateSchedule(config, now) {
  if (config.autoEnabled !== true) return { permitted: false, reason: "disabled" };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return { permitted: false, reason: "invalid_configuration" };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("Invalid time");
    const current = hour * 60 + minute;
    // Evaluate both intervals so invalid configuration always fails closed.
    const allowed = inInterval(current, config.allowedStart, config.allowedEnd);
    const sleeping = inInterval(current, config.sleepStart, config.sleepEnd);
    if (sleeping) return { permitted: false, reason: "sleeping" };
    if (!allowed) return { permitted: false, reason: "outside_allowed_hours" };
    return { permitted: true, reason: "schedule_permitted" };
  } catch {
    return { permitted: false, reason: "invalid_configuration" };
  }
}
