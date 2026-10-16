// Smoke object service for the processor harness (issue #284).
//
// Stands in for object storage during the native processor smoke: it serves one
// exact object per GET and records one exact object per PUT, so the harness can
// inspect the bytes the engine actually wrote. It exists only so the native
// compute proof does not depend on local R2 emulation; the engine still sees
// nothing but a GET capability and a PUT capability, and no credential of any
// kind crosses this boundary.
//
// Env: FIXTURE_DIR (root holding `objects/`), FIXTURE_PORT.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const fixtureDir = process.env.FIXTURE_DIR ?? "/fixtures";
const port = Number(process.env.FIXTURE_PORT ?? 8099);
const objectsDir = path.join(fixtureDir, "objects");

/** Uploads the engine performed, newest last; read back by the harness assertions. */
const recorded = [];

/**
 * Resolves a request path to a file inside the objects directory, refusing any
 * traversal so a crafted job URL cannot read outside the fixture set.
 */
function objectPath(name) {
  const resolved = path.resolve(objectsDir, name);
  if (!resolved.startsWith(`${objectsDir}${path.sep}`)) return null;
  return resolved;
}

/**
 * Serves one exact object with an accurate content length, which is what lets
 * the engine verify the declared size before decoding anything.
 */
async function serveObject(response, name) {
  const file = objectPath(name);
  if (!file) {
    response.writeHead(400).end();
    return;
  }
  try {
    const { size } = await stat(file);
    response.writeHead(200, {
      "content-length": String(size),
      "content-type": "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "content-length": "0" }).end();
  }
}

/**
 * Removes one exact object, standing in for the Worker's staging-clear step:
 * before re-invoking a job whose verdict was never recorded, the Worker deletes
 * the unrecorded output so a replay must prove it can recreate the bytes.
 * Idempotent like a real object delete: a missing object still answers 204.
 */
async function deleteObject(response, name) {
  const file = objectPath(name);
  if (!file) {
    response.writeHead(400, { "content-length": "0" }).end();
    return;
  }
  await rm(file, { force: true });
  response.writeHead(204, { "content-length": "0" }).end();
}

/**
 * Stores one exact object, honouring create-only semantics when the request
 * carries `If-None-Match: *` so a replayed capability cannot overwrite bytes.
 */
async function storeObject(request, response, name) {
  const file = objectPath(name);
  if (!file) {
    response.writeHead(400, { "content-length": "0" }).end();
    return;
  }
  const createOnly = (request.headers["if-none-match"] ?? "") === "*";
  if (createOnly) {
    try {
      await stat(file);
      response.writeHead(412, { "content-length": "0" }).end();
      return;
    } catch {
      // No object yet, so the create is allowed to proceed.
    }
  }
  // The upload lands beside the fixtures so a later job can legitimately read a
  // rendition back as its own input, exactly as a crash retry would.
  const bytes = await storeBody(request, file, name);
  response.writeHead(200, { "content-length": "0", etag: `"${bytes.toString(16)}"` }).end();
}

/**
 * Streams a request body to disk and records its digest and size, so the
 * harness can compare the stored bytes against what the engine reported.
 */
async function storeBody(request, target, name) {
  const digest = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const sink = createWriteStream(target);
    request.on("data", (chunk) => {
      bytes += chunk.length;
      digest.update(chunk);
    });
    request.on("error", reject);
    sink.on("error", reject);
    sink.on("finish", resolve);
    request.pipe(sink);
  });
  recorded.push({ bytes, key: name, sha256: digest.digest("hex") });
  return bytes;
}

await mkdir(objectsDir, { recursive: true });

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixtures.local");
  if (request.method === "GET" && url.pathname === "/_recorded") {
    const body = JSON.stringify(recorded);
    response
      .writeHead(200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      })
      .end(body);
    return;
  }
  if (request.method === "GET" && url.pathname === "/_objects") {
    readdir(objectsDir)
      .then((names) => {
        const body = JSON.stringify(names);
        response
          .writeHead(200, {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
          })
          .end(body);
      })
      .catch(() => response.writeHead(500, { "content-length": "0" }).end());
    return;
  }
  const name = decodeURIComponent(url.pathname.replace(/^\/objects\//, ""));
  if (request.method === "GET" && url.pathname.startsWith("/objects/")) {
    void serveObject(response, name);
    return;
  }
  if (request.method === "PUT" && url.pathname.startsWith("/objects/")) {
    void storeObject(request, response, name);
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/objects/")) {
    void deleteObject(response, name);
    return;
  }
  response.writeHead(405, { "content-length": "0" }).end();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`fixture object service listening on 0.0.0.0:${port} (${objectsDir})`);
});
