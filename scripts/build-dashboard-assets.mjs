import { mkdir, readFile, writeFile } from "node:fs/promises";

const out = new URL("../.wrangler/generated/", import.meta.url);
const entries = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/ui.css", "ui.css", "text/css; charset=utf-8"],
  ["/ui.js", "ui.js", "text/javascript; charset=utf-8"],
];
const assets = Object.fromEntries(await Promise.all(entries.map(async ([path, file, type]) =>
  [path, [await readFile(new URL("../dashboard/" + file, import.meta.url), "utf8"), type]])));
await mkdir(out, { recursive: true });
await writeFile(new URL("dashboard-assets.mjs", out), "export default " + JSON.stringify(assets) + ";\n");
