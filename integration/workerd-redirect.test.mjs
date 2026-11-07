import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("workerd permits manual redirects without forwarding credentials to the target", async () => {
  let initial = 0;
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { initial++; response.writeHead(302, { location: "/target" }); response.end(); }
    else { redirected++; response.writeHead(200); response.end("unexpected"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const paths = ["../fixtures/worker-redirect-fixture.mjs", "../src/github-dispatch.mjs", "../src/github-oidc.mjs",
    "../src/notify.mjs", "../src/recovery.mjs", "../src/http-utils.mjs"];
  const modules = paths.map((path) => ({ type: "ESModule", path: fileURLToPath(new URL(path, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-10-01",
    modulesRoot: fileURLToPath(new URL("..", import.meta.url)), bindings: { TEST_SERVER: `http://127.0.0.1:${server.address().port}` } }));
  try {
    const response = await mf.dispatchFetch("http://test/");
    assert.deepEqual(await response.json(), { dispatch: "unknown", notification: "unconfirmed", recovery: false, jwksRejected: true });
    assert.equal(initial, 4);
    assert.equal(redirected, 0);
  } finally {
    await mf.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
