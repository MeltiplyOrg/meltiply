import { describe, expect, it, vi } from "vite-plus/test";

import { S3ObjectStore, S3SigV4Signer } from "../src";

interface RecordedRequest {
  body: string | null;
  headers: Headers;
  method: string;
  url: URL;
}

async function readBody(body: BodyInit | null | undefined): Promise<string | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  return new TextDecoder().decode(await new Response(body).arrayBuffer());
}

function fakeOrigin(
  respond: (request: RecordedRequest, index: number) => Response | Promise<Response>,
): { requests: RecordedRequest[]; store: S3ObjectStore } {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      body: await readBody(init?.body),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url: new URL(String(input)),
    };
    requests.push(request);
    return respond(request, requests.length - 1);
  });
  const store = new S3ObjectStore({
    accessKeyId: "minioadmin",
    bucket: "meltiply-assets",
    endpoint: "https://objects.example.com",
    fetch: (input, init) => fetchMock(input, init),
    now: () => new Date("2026-07-18T12:34:56Z"),
    region: "eu-west-1",
    secretAccessKey: "minioadmin",
  });
  return { requests, store };
}

function headResponse(overrides: Record<string, string> = {}, status = 200): Response {
  return new Response(null, {
    headers: {
      "content-length": "42",
      "content-type": "image/png",
      etag: '"abc123"',
      "last-modified": "Sat, 18 Jul 2026 12:00:00 GMT",
      ...overrides,
    },
    status,
  });
}

describe("S3ObjectStore metadata", () => {
  it("normalizes origin headers into ObjectMetadata", async () => {
    const { requests, store } = fakeOrigin(() =>
      headResponse({
        "x-amz-checksum-sha256": "BsCuUn6yITEdlC7KOO9YQiLL6NuLUdp/p+Ze2Ex2xWg=",
        "x-amz-version-id": "version-one",
      }),
    );

    await expect(store.head("org/asset/image.png")).resolves.toEqual({
      contentType: "image/png",
      customMetadata: null,
      etag: "abc123",
      key: "org/asset/image.png",
      sha256: "06c0ae527eb221311d942eca38ef584222cbe8db8b51da7fa7e65ed84c76c568",
      size: 42,
      uploadedAt: new Date("Sat, 18 Jul 2026 12:00:00 GMT"),
      version: "version-one",
    });
    expect(requests[0]?.method).toBe("HEAD");
    expect(requests[0]?.url.pathname).toBe("/meltiply-assets/org/asset/image.png");
    expect(requests[0]?.headers.get("authorization")).toContain(
      "Credential=minioadmin/20260718/eu-west-1/s3/aws4_request",
    );
    expect(requests[0]?.headers.has("host")).toBe(false);
  });

  it("treats an origin 404 as an absent object rather than a failure", async () => {
    const { store } = fakeOrigin(() => new Response(null, { status: 404 }));
    await expect(store.head("org/asset/missing.png")).resolves.toBeNull();
  });

  it("surfaces an origin failure instead of reporting the object absent", async () => {
    const { store } = fakeOrigin(() => new Response("nope", { status: 500 }));
    await expect(store.head("org/asset/image.png")).rejects.toThrow(
      "object metadata request failed with status 500",
    );
  });
});

describe("S3ObjectStore reads", () => {
  it("streams a whole object for relay", async () => {
    const { requests, store } = fakeOrigin(
      () =>
        new Response("png-bytes", {
          headers: { "content-length": "9", "content-type": "image/png" },
        }),
    );

    const object = await store.read("org/asset/image.png");

    expect(requests[0]?.url.pathname).toBe("/meltiply-assets/org/asset/image.png");
    expect(object?.contentType).toBe("image/png");
    expect(object?.size).toBe(9);
    await expect(new Response(object?.body).text()).resolves.toBe("png-bytes");
  });

  it("reads a bounded range and reports a range past the end as null", async () => {
    const { requests, store } = fakeOrigin((_request, index) =>
      index === 0
        ? new Response(new Uint8Array([1, 2, 3]), { status: 206 })
        : new Response(null, { status: 416 }),
    );

    await expect(store.readPrefix("org/asset/image.png", 3)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(requests[0]?.headers.get("range")).toBe("bytes=0-2");
    await expect(store.readRange("org/asset/image.png", 8, 3)).resolves.toBeNull();
    expect(requests[1]?.headers.get("range")).toBe("bytes=8-10");
  });

  it("admits exactly 1 MiB and rejects out-of-range reads before touching the origin", async () => {
    const { requests, store } = fakeOrigin(() => new Response(new Uint8Array(), { status: 206 }));
    await expect(store.readPrefix("org/asset/image.png", 0)).rejects.toThrow("maximumBytes");
    await expect(store.readPrefix("org/asset/image.png", 1024 * 1024)).resolves.toEqual(
      new Uint8Array(),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("range")).toBe("bytes=0-1048575");
    await expect(store.readPrefix("org/asset/image.png", 1024 * 1024 + 1)).rejects.toThrow(
      "maximumBytes",
    );
    await expect(store.readRange("org/asset/image.png", -1, 4)).rejects.toThrow("offset");
    expect(requests).toHaveLength(1);
  });
});

describe("S3ObjectStore writes", () => {
  it("deletes an object and treats an already-removed key as success", async () => {
    const { requests, store } = fakeOrigin((_request, index) =>
      index === 0 ? new Response(null, { status: 204 }) : new Response(null, { status: 404 }),
    );

    await expect(store.delete("org/asset/image.png")).resolves.toBeUndefined();
    await expect(store.delete("org/asset/image.png")).resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });
});

describe("S3ObjectStore copy", () => {
  it("copies server-side under a pinned source ETag", async () => {
    const { requests, store } = fakeOrigin((_request, index) => {
      if (index === 0) return new Response(null, { status: 404 });
      if (index === 1) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ETag>"ready-etag"</ETag><LastModified>2026-07-18T12:00:00.000Z</LastModified></CopyObjectResult>',
          { headers: { "content-type": "application/xml" } },
        );
      }
      return headResponse({ etag: '"ready-etag"' });
    });

    await expect(
      store.copyObject("staging/org/asset/session/image.png", "org/asset/original", {
        contentType: "image/png",
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "staged-etag",
      }),
    ).resolves.toMatchObject({ etag: "ready-etag", key: "org/asset/original" });

    const [probe, copy] = requests;
    expect(probe?.method).toBe("HEAD");
    expect(copy?.method).toBe("PUT");
    expect(copy?.body).toBeNull();
    expect(copy?.headers.get("x-amz-copy-source")).toBe(
      "/meltiply-assets/staging/org/asset/session/image.png",
    );
    expect(copy?.headers.get("x-amz-copy-source-if-match")).toBe('"staged-etag"');
    expect(copy?.headers.get("if-none-match")).toBe("*");
    expect(copy?.headers.get("content-type")).toBe("image/png");
    expect(copy?.headers.get("x-amz-metadata-directive")).toBe("REPLACE");
  });

  it("adopts an existing destination instead of rewriting it", async () => {
    const { requests, store } = fakeOrigin(() => headResponse());

    await expect(
      store.copyObject("staging/org/asset/session/image.png", "org/asset/original", {
        ifDestinationAbsent: true,
      }),
    ).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("reports a rejected precondition as no promotion", async () => {
    const { requests, store } = fakeOrigin((_request, index) =>
      index === 0 ? new Response(null, { status: 404 }) : new Response(null, { status: 412 }),
    );

    await expect(
      store.copyObject("staging/org/asset/session/image.png", "org/asset/original", {
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "moved-on",
      }),
    ).resolves.toBeNull();
    expect(requests.some((request) => request.method === "PUT")).toBe(true);
  });

  it("surfaces a copy origin failure instead of reporting no promotion", async () => {
    const { store } = fakeOrigin((_request, index) =>
      index === 0 ? new Response(null, { status: 404 }) : new Response("boom", { status: 500 }),
    );

    await expect(
      store.copyObject("staging/org/asset/session/image.png", "org/asset/original", {
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "staged-etag",
      }),
    ).rejects.toThrow("object copy failed with status 500");
  });
});

describe("S3ObjectStore multipart uploads", () => {
  it.each(["typed array", "DataView"])("signs and uploads only a bounded %s", async (kind) => {
    const { requests, store } = fakeOrigin(
      () => new Response(null, { headers: { etag: '"part-etag"' } }),
    );
    const bytes = new Uint8Array([0, 97, 98, 99, 0]);
    const value = kind === "DataView" ? new DataView(bytes.buffer, 1, 3) : bytes.subarray(1, 4);

    await store.resumeMultipartUpload("org/asset/clip.mp4", "upload-9").uploadPart(1, value);

    expect(requests[0]?.body).toBe("abc");
    expect(requests[0]?.headers.get("x-amz-content-sha256")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("drives create, part, complete, and abort against the S3 protocol", async () => {
    const { requests, store } = fakeOrigin((_request, index) => {
      if (index === 0) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>meltiply-assets</Bucket><Key>org/asset/clip.mp4</Key><UploadId>upload-9</UploadId></InitiateMultipartUploadResult>',
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (index === 2) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>https://objects.example.com/meltiply-assets/org/asset/clip.mp4</Location><Bucket>meltiply-assets</Bucket><Key>org/asset/clip.mp4</Key><ETag>"complete-etag"</ETag></CompleteMultipartUploadResult>',
          { headers: { "content-type": "application/xml" } },
        );
      }
      return index === 3
        ? headResponse({
            "content-length": "4",
            "content-type": "video/mp4",
            etag: '"complete-etag"',
          })
        : new Response(null, { headers: { etag: '"part-one-etag"' }, status: 200 });
    });

    const upload = await store.createMultipartUpload("org/asset/clip.mp4", "video/mp4");
    expect(upload.uploadId).toBe("upload-9");
    const part = await upload.uploadPart(1, new Uint8Array([1, 2]));
    expect(part).toEqual({ etag: "part-one-etag", partNumber: 1 });
    await expect(upload.complete([part])).resolves.toMatchObject({
      contentType: "video/mp4",
      etag: "complete-etag",
      key: "org/asset/clip.mp4",
      size: 4,
    });

    const aborted = store.resumeMultipartUpload("org/asset/clip.mp4", "upload-9");
    expect(aborted.uploadId).toBe("upload-9");
    await expect(aborted.abort()).resolves.toBeUndefined();

    expect(requests[0]?.url.searchParams.get("uploads")).toBe("");
    expect(requests[1]?.url.searchParams.get("partNumber")).toBe("1");
    expect(requests[1]?.url.searchParams.get("uploadId")).toBe("upload-9");
    expect(requests[2]?.body).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>part-one-etag</ETag></Part></CompleteMultipartUpload>",
    );
    expect(requests[4]?.method).toBe("DELETE");
    expect(requests[4]?.url.searchParams.get("uploadId")).toBe("upload-9");
  });

  it("fails when the origin returns no upload id", async () => {
    const { store } = fakeOrigin(() => new Response("<InitiateMultipartUploadResult/>"));
    await expect(store.createMultipartUpload("org/asset/clip.mp4", "video/mp4")).rejects.toThrow(
      "no UploadId",
    );
  });
});

describe("S3SigV4Signer", () => {
  const options = {
    accessKeyId: "AKIAEXAMPLE",
    bucket: "meltiply-assets",
    endpoint: "https://objects.example.com",
    now: () => new Date("2026-07-18T12:34:56Z"),
    region: "eu-west-1",
    secretAccessKey: "super-secret-key",
  };

  it("signs path-style presigned URLs in the configured region", async () => {
    const signed = new URL(
      await new S3SigV4Signer(options).signUpload({
        contentLength: 42,
        contentType: "image/png",
        expiresInSeconds: 900,
        key: "org one/asset/image.png",
      }),
    );

    expect(signed.origin).toBe("https://objects.example.com");
    expect(signed.pathname).toBe("/meltiply-assets/org%20one/asset/image.png");
    expect(signed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAEXAMPLE/20260718/eu-west-1/s3/aws4_request",
    );
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(signed.toString()).not.toContain("super-secret-key");
  });

  it("moves the bucket into the host when path-style addressing is disabled", async () => {
    const signed = new URL(
      await new S3SigV4Signer({ ...options, forcePathStyle: false }).signDownload({
        expiresInSeconds: 60,
        key: "org/asset/image.png",
      }),
    );

    expect(signed.origin).toBe("https://meltiply-assets.objects.example.com");
    expect(signed.pathname).toBe("/org/asset/image.png");
  });

  it("binds a create-only write capability to its required header", async () => {
    const signed = new URL(
      await new S3SigV4Signer(options).signObjectWrite({
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: { "If-None-Match": "*" },
      }),
    );

    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
  });

  it("rejects an untrusted plain-HTTP origin outside development", () => {
    expect(
      () =>
        new S3SigV4Signer({
          ...options,
          endpoint: "http://objects.example.com",
        }),
    ).toThrow("HTTPS");
    expect(
      () =>
        new S3SigV4Signer({
          ...options,
          allowInsecureEndpoint: true,
          endpoint: "http://objects.example.com",
        }),
    ).not.toThrow();
  });
});
