#!/usr/bin/env node
/**
 * CI-only static preview for Lighthouse performance measurement.
 *
 * Cloudflare compresses text assets at its edge, while Vite's local preview
 * serves them identity-encoded. Measuring the uncompressed local preview makes
 * the performance budget report a transfer time production never pays. This
 * server serves the built client with production-like brotli/gzip negotiation
 * and proxies `/api` and `/health` to the local Worker, so the audit measures a
 * working production build instead of a compression artifact.
 *
 * Usage: node scripts/ci/lighthouse-preview.mjs [--root dist/client] [--port 3000]
 *
 * The server is bounded to the given asset root and local API origin. It is not
 * a deployment server and is only started by the `frontend-full` lane.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer, request } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const root = resolve(args.get("--root") ?? "dist/client");
const port = Number(args.get("--port") ?? 3000);
const apiOrigin = new URL(process.env.API_ORIGIN?.trim() || "http://127.0.0.1:8787");
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid preview port: ${port}`);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(apiOrigin.hostname)) {
  throw new Error(`Preview API origin must be loopback: ${apiOrigin.origin}`);
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".json", "application/json"],
  [".txt", "text/plain; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
]);
const compressible = new Set([".html", ".js", ".css", ".svg", ".json", ".txt", ".webmanifest"]);

/**
 * Reads one request target from the asset root, falling back to the SPA shell.
 *
 * @param pathname - Decoded request pathname.
 * @returns The resolved file path and whether it is the SPA fallback.
 * @throws When the path escapes the asset root.
 */
async function resolveAsset(pathname) {
  const candidate = normalize(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error("Path escapes the asset root");
  }
  try {
    const info = await stat(candidate);
    if (info.isFile()) return { fallback: false, path: candidate };
  } catch {
    // Missing files use the Worker's single-page-application fallback.
  }
  return { fallback: true, path: join(root, "index.html") };
}

/**
 * Encodes one text asset when the caller advertises brotli or gzip.
 *
 * @param body - Uncompressed asset bytes.
 * @param extension - Lowercase file extension including the dot.
 * @param acceptEncoding - Request `Accept-Encoding` value.
 * @returns The response bytes and content encoding, or null for identity.
 */
function encode(body, extension, acceptEncoding) {
  if (!compressible.has(extension)) return null;
  if (acceptEncoding.includes("br")) {
    return {
      body: brotliCompressSync(body, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
      }),
      encoding: "br",
    };
  }
  if (acceptEncoding.includes("gzip")) {
    return { body: gzipSync(body), encoding: "gzip" };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
    const upstream = request(
      {
        headers: { ...req.headers, host: apiOrigin.host },
        host: apiOrigin.hostname.replace(/^\[|\]$/g, ""),
        method: req.method,
        path: req.url,
        port: apiOrigin.port || 80,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("API proxy failed");
    });
    req.pipe(upstream);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  try {
    const asset = await resolveAsset(decodeURIComponent(url.pathname));
    const extension = extname(asset.path).toLowerCase();
    const body = await readFile(asset.path);
    const contentType = contentTypes.get(extension) ?? "application/octet-stream";
    const encoded = encode(body, extension, req.headers["accept-encoding"] ?? "");
    const headers = {
      "cache-control": asset.fallback ? "no-cache" : "public,max-age=31536000,immutable",
      "content-type": contentType,
      vary: "accept-encoding",
    };
    if (encoded) {
      headers["content-encoding"] = encoded.encoding;
      headers["content-length"] = String(encoded.body.byteLength);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : encoded.body);
      return;
    }
    headers["content-length"] = String(body.byteLength);
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lighthouse preview listening on http://127.0.0.1:${port}`);
});
