// Live object storage check. With no arguments, uses Miniflare's S3 gateway.
// S3_CHECK_ENDPOINT selects a disposable, empty S3-compatible bucket instead;
// the hosted object-storage lane uses MinIO to also exercise server-side copy.
// Never point this check at a production bucket: it creates and deletes objects.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { S3ObjectStore, S3SigV4Signer } from "../../packages/storage/src/index";

const bucket = process.env.S3_CHECK_BUCKET ?? "meltiply-assets";
const credentials = {
  accessKeyId: process.env.S3_CHECK_ACCESS_KEY ?? "s3-check-access-key",
  secretAccessKey: process.env.S3_CHECK_SECRET_KEY ?? "s3-check-secret-key",
};

/**
 * Reserves an ephemeral loopback port for the gateway.
 *
 * @returns A port that was free a moment ago; the caller binds it immediately.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object", "expected a bound TCP address");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

const externalEndpoint = process.env.S3_CHECK_ENDPOINT;
const port = externalEndpoint ? 0 : await freePort();
const endpoint = externalEndpoint ?? `http://127.0.0.1:${port}`;

const runtime = externalEndpoint
  ? undefined
  : new Miniflare(
      convertV4MiniflareOptions({
        host: "127.0.0.1",
        port,
        cf: {},
        logRequests: false,
        telemetry: { enabled: false },
        workers: [
          {
            compatibilityDate: "2026-07-01",
            compatibilityFlags: [],
            modules: true,
            name: "s3-gateway",
            r2Buckets: { ASSETS: { id: bucket, s3Credentials: credentials } },
            script: "export default { fetch() { return new Response('ok'); } };",
          },
        ],
      }),
    );
await runtime?.ready;

const signer = new S3SigV4Signer({
  accessKeyId: credentials.accessKeyId,
  allowInsecureEndpoint: true,
  bucket,
  endpoint,
  ...(externalEndpoint ? {} : { endpointPathPrefix: "/cdn-cgi/local/r2/s3" }),
  region: "us-east-1",
  secretAccessKey: credentials.secretAccessKey,
});
const store = new S3ObjectStore({
  accessKeyId: credentials.accessKeyId,
  allowInsecureEndpoint: true,
  bucket,
  endpoint,
  ...(externalEndpoint ? {} : { endpointPathPrefix: "/cdn-cgi/local/r2/s3" }),
  region: "us-east-1",
  secretAccessKey: credentials.secretAccessKey,
});

const key = "org-1/asset-1/original";
const body = "live-signature-check-bytes";

try {
  if (externalEndpoint) {
    const request = await signer.requestSigner().prepareBucketRequest("PUT");
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(request.url, { headers, method: "PUT" });
    assert.equal(response.status, 200, await response.text());
  }
  // An absent object must read as absent rather than as an origin failure.
  assert.equal(await store.head(key), null);

  // Header-signed SigV4: the path the worker itself uses for reads and writes.
  const upload = await store.createMultipartUpload(key, "video/mp4");
  const part = await upload.uploadPart(1, new TextEncoder().encode(body));
  const completed = await upload.complete([part]);
  assert.equal(completed.key, key);
  assert.equal(completed.size, body.length);
  assert.ok(completed.etag, "expected an ETag from the origin");

  const object = await store.read(key);
  assert.ok(object, "expected the written object to read back");
  assert.equal(object.contentType, "video/mp4");
  assert.equal(await new Response(object.body).text(), body);
  assert.deepEqual(
    [...((await store.readRange(key, 0, 4)) ?? [])],
    [...new TextEncoder().encode(body.slice(0, 4))],
  );

  if (externalEndpoint) {
    const copied = await store.copyObject(key, `${key}-ready`, {
      contentType: "video/mp4",
      ifDestinationAbsent: true,
      ifSourceEtagMatches: completed.etag,
    });
    assert.ok(copied, "promotion must copy a pinned source");
    assert.equal(await new Response((await store.read(`${key}-ready`))?.body).text(), body);
    assert.equal(await store.copyObject(key, `${key}-ready`, { ifDestinationAbsent: true }), null);
    assert.equal(
      await store.copyObject(key, `${key}-stale`, {
        ifSourceEtagMatches: "stale-etag",
      }),
      null,
    );
    await store.delete(`${key}-ready`);
  }

  // Presigned upload: the capability a browser receives for a direct PUT.
  const uploadUrl = await signer.signUpload({
    contentLength: 4,
    contentType: "image/png",
    expiresInSeconds: 300,
    key: "org-1/asset-1/presigned",
  });
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-length": "4", "content-type": "image/png" },
    body: "abcd",
  });
  assert.equal(uploaded.status, 200, await uploaded.text());

  // Presigned download: the capability previews, downloads, and Provider media
  // delivery all rely on.
  const downloadUrl = await signer.signDownload({ expiresInSeconds: 300, key });
  const downloaded = await fetch(downloadUrl);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), body);

  // Presigned multipart part: one part of a browser-driven multipart upload.
  const resumable = await store.createMultipartUpload("org-1/asset-1/parts", "video/mp4");
  const partUrl = await signer.signMultipartPart({
    contentLength: 4,
    contentType: "video/mp4",
    expiresInSeconds: 300,
    key: "org-1/asset-1/parts",
    partNumber: 1,
    uploadId: resumable.uploadId,
  });
  const partResponse = await fetch(partUrl, {
    method: "PUT",
    headers: { "content-length": "4", "content-type": "video/mp4" },
    body: "wxyz",
  });
  assert.equal(partResponse.status, 200, await partResponse.text());
  await resumable.abort();

  // Create-only exact-object write: the native processor's rendition grant. It
  // must create once and then refuse, or a retry could overwrite committed
  // bytes.
  const writeUrl = await signer.signObjectWrite({
    expiresInSeconds: 300,
    key: "org-1/asset-1/processing",
    requiredHeaders: { "if-none-match": "*" },
  });
  const firstWrite = await fetch(writeUrl, {
    method: "PUT",
    headers: { "if-none-match": "*" },
    body: "created",
  });
  assert.equal(firstWrite.status, 200, await firstWrite.text());
  const replayedWrite = await fetch(writeUrl, {
    method: "PUT",
    headers: { "if-none-match": "*" },
    body: "overwritten",
  });
  assert.equal(replayedWrite.status, 412, "a create-only write must refuse an existing key");

  await store.delete(key);
  assert.equal(await store.head(key), null);

  console.log("S3 provider signature accepted by a live S3 gateway.");
} finally {
  await runtime?.dispose();
}
