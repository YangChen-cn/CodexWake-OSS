import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseAuthFile } from "./credential-bundle.mjs";

// Explicit paths only: never inspect the user's default Codex credentials.
// The caller must use a separately logged-in CODEX_HOME and must not keep
// using that same OAuth token copy outside the serialized cloud workflow.
export async function readLocalAuthFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || constants.O_NOFOLLOW === undefined) throw new Error("Invalid isolated auth file");
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error("Unsafe auth file permissions");
    }
    const buffer = Buffer.alloc(48 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 48 * 1024) throw new Error("Credential file too large");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    parseAuthFile(text);
    return text;
  } catch { throw new Error("Isolated ChatGPT credential file is unavailable or invalid"); }
  finally { await file?.close(); }
}
