import { explicitActivity, handleActivityHook, runLocalObservation } from "../src/local-activity.mjs";

const mode = process.argv[2];
try {
  if (mode === "hook") {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) break;
      chunks.push(chunk);
    }
    if (bytes <= 1024 * 1024) await handleActivityHook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } else if (mode === "observe" || mode === "confirm-user-turn") {
    const result = await runLocalObservation(mode === "confirm-user-turn" ? { activity: explicitActivity() } : {});
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (["quota_unavailable", "report_unconfirmed", "observer_busy"].includes(result.outcome)) process.exitCode = 1;
  } else throw new Error("Unknown command");
} catch {
  if (mode !== "hook") {
    process.stderr.write("Local activity operation failed. Check monitor setup.\n");
    process.exitCode = 1;
  }
}
