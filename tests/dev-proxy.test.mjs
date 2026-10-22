import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createServer,
  loadConfigFromFile,
} from "../apps/web/node_modules/vite/dist/node/index.js";

test("development API proxy preserves public Host, Origin and CSRF headers", async () => {
  const backend = createHttpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        host: req.headers.host,
        origin: req.headers.origin,
        csrf: req.headers["x-csrf-token"],
        method: req.method,
        path: req.url,
      }),
    );
  });
  let vite;
  const frontend = createHttpServer((req, res) => vite.middlewares(req, res));
  try {
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const target = `http://127.0.0.1:${backend.address().port}`;
    const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "production" },
      fileURLToPath(new URL("../apps/web/vite.config.ts", import.meta.url)),
      web,
    );
    assert(loaded, "Vite configuration must load");
    const proxy = loaded.config.server?.proxy?.["/api"];
    const mediaProxy = loaded.config.server?.proxy?.["/media"];
    assert(mediaProxy, "Vite must proxy private media requests");
    assert(proxy, "Vite must proxy API requests");
    vite = await createServer({
      ...loaded.config,
      configFile: false,
      root: web,
      mode: "production",
      server: {
        ...loaded.config.server,
        host: "127.0.0.1",
        middlewareMode: true,
        hmr: false,
        // Only replace the destination; retain the application's proxy behavior.
        proxy: {
          "/api": typeof proxy === "string" ? target : { ...proxy, target },
          "/media": typeof mediaProxy === "string" ? target : { ...mediaProxy, target },
        },
      },
    });
    frontend.listen(0, "127.0.0.1");
    await once(frontend, "listening");
    const port = frontend.address().port;
    const send = (origin, path = "/api/v1/admin/mfa/setup", method = "POST") =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            method,
            path,
            headers: {
              Host: "127.0.0.1:5173",
              Origin: origin,
              "X-CSRF-Token": "proxy-test-fixture-only",
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
              try {
                assert.equal(res.statusCode, 200);
                resolve(JSON.parse(body));
              } catch (error) {
                reject(error);
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.setTimeout(5000, () =>
          req.destroy(new Error("Proxy request timed out")),
        );
        req.end();
      });
    const expected = {
      host: "127.0.0.1:5173",
      origin: "http://127.0.0.1:5173",
      csrf: "proxy-test-fixture-only",
      method: "POST",
      path: "/api/v1/admin/mfa/setup",
    };
    assert.deepEqual(await send(expected.origin), expected);
    assert.deepEqual(await send(expected.origin, "/media/test/original?expires=123&signature=test-only", "GET"), {...expected, method:"GET", path:"/media/test/original?expires=123&signature=test-only"});
    // Never replace an untrusted Origin with a trusted one to make CSRF pass.
    assert.deepEqual(await send("https://untrusted.example"), {
      ...expected,
      origin: "https://untrusted.example",
    });
  } finally {
    await vite?.close();
    await new Promise((resolve) => frontend.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
  }
});
