import { beforeAll, describe, expect, it } from "vite-plus/test";

import { S3ObjectStore, S3SigV4Signer, type S3SigV4SignerOptions } from "../src/s3";

const NOW = new Date("2026-07-18T12:34:56Z");
const KEY = "org/asset/image.png";
const PATH = "/meltiply-assets/org/asset/image.png";

const options: S3SigV4SignerOptions = {
  accessKeyId: "AKIAEXAMPLE",
  bucket: "meltiply-assets",
  endpoint: "https://objects.example.com",
  now: () => NOW,
  region: "eu-west-1",
  secretAccessKey: "super-secret-key",
};

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

class FakeS3Origin {
  readonly requests: Sent[] = [];
  readonly signatures: { authorization?: string; payloadHash?: string }[] = [];
  private readonly answers: (Response | Error)[];

  constructor(answers: (Response | Error)[]) {
    this.answers = answers;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers));
    const {
      authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": _date,
      ...rest
    } = headers;
    this.signatures.push({ authorization, payloadHash });
    this.requests.push({
      method: init?.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      headers: rest,
      ...(init?.body ? { body: await new Response(init.body).text() } : {}),
    });
    const answer = this.answers.shift() ?? new Response(null, { status: 599 });
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

function setup(...answers: (Response | Error)[]) {
  const origin = new FakeS3Origin(answers);
  const store = new S3ObjectStore({ ...options, fetch: origin.fetch });
  return { origin, store };
}

const status = (code: number) => new Response(null, { status: code });
const xml = (body: string) => new Response(body);
const head = (headers: Record<string, string> = {}) =>
  new Response(null, {
    headers: {
      "content-length": "42",
      "content-type": "image/png",
      etag: '"abc123"',
      "last-modified": "Sat, 18 Jul 2026 12:00:00 GMT",
      ...headers,
    },
  });
const metadata = {
  contentType: "image/png",
  customMetadata: null,
  etag: "abc123",
  key: KEY,
  sha256: null,
  size: 42,
  uploadedAt: new Date("2026-07-18T12:00:00Z"),
  version: null,
};
const sent = (method: string, url = PATH, headers: Record<string, string> = {}) => ({
  method,
  url,
  headers,
});

beforeAll(async () => {
  await setup(head()).store.head(KEY);
});

describe("S3ObjectStore", () => {
  describe("head", () => {
    it("an object with a checksum, a version and a weak ETag", async () => {
      const { origin, store } = setup(
        head({
          etag: 'W/"abc123"',
          "x-amz-checksum-sha256": "BsCuUn6yITEdlC7KOO9YQiLL6NuLUdp/p+Ze2Ex2xWg=",
          "x-amz-version-id": "version-one",
        }),
      );

      expect(await store.head(KEY)).toEqual({
        ...metadata,
        sha256: "06c0ae527eb221311d942eca38ef584222cbe8db8b51da7fa7e65ed84c76c568",
        version: "version-one",
      });
      expect(origin.requests).toEqual([sent("HEAD")]);
      expect(origin.signatures.map((signature) => signature.authorization)).toEqual([
        expect.stringContaining("Credential=AKIAEXAMPLE/20260718/eu-west-1/s3/aws4_request"),
      ]);
    });

    it("an answer with no usable headers", async () => {
      const { store } = setup(
        new Response(null, {
          headers: {
            "content-length": "-1",
            "last-modified": "never",
            "x-amz-checksum-sha256": "!!",
          },
        }),
      );

      expect(await store.head(KEY)).toEqual({
        contentType: null,
        customMetadata: null,
        etag: "",
        key: KEY,
        sha256: null,
        size: 0,
        uploadedAt: new Date(0),
        version: null,
      });
    });

    it("a missing object", async () => {
      const { store } = setup(status(404));

      expect(await store.head(KEY)).toEqual(null);
    });

    it("an origin that fails", async () => {
      const { store } = setup(status(500));

      await expect(store.head(KEY)).rejects.toThrow(
        new Error("object metadata request failed with status 500"),
      );
    });

    it("an origin that cannot be reached", async () => {
      const cause = new TypeError("fetch failed");
      const { store } = setup(cause);

      await expect(store.head(KEY)).rejects.toEqual(
        new Error("object storage transport failed", { cause }),
      );
    });
  });

  describe("read", () => {
    it("an object", async () => {
      const { origin, store } = setup(
        new Response("png-bytes", {
          headers: { "content-length": "9", "content-type": "image/png" },
        }),
      );

      const object = await store.read(KEY);

      expect({ ...object, body: await new Response(object?.body).text() }).toEqual({
        body: "png-bytes",
        contentType: "image/png",
        size: 9,
      });
      expect(origin.requests).toEqual([sent("GET")]);
    });

    it("a missing object", async () => {
      const { store } = setup(status(404));

      expect(await store.read(KEY)).toEqual(null);
    });

    it("an origin that fails", async () => {
      const { store } = setup(status(500));

      await expect(store.read(KEY)).rejects.toThrow("object read failed with status 500");
    });

    it("an answer without a body", async () => {
      const { store } = setup(status(204));

      await expect(store.read(KEY)).rejects.toThrow(new Error("object body is unavailable"));
    });
  });

  describe("readRange", () => {
    it("a range", async () => {
      const { origin, store } = setup(new Response(new Uint8Array([1, 2, 3]), { status: 206 }));

      expect(await store.readRange(KEY, 8, 3)).toEqual(new Uint8Array([1, 2, 3]));
      expect(origin.requests).toEqual([sent("GET", PATH, { range: "bytes=8-10" })]);
    });

    it.each([
      ["a missing object", 404],
      ["a range past the end", 416],
    ])("%s", async (_example, code) => {
      const { store } = setup(status(code));

      expect(await store.readRange(KEY, 0, 1)).toEqual(null);
    });

    it("an origin that fails", async () => {
      const { store } = setup(status(500));

      await expect(store.readRange(KEY, 0, 1)).rejects.toThrow(
        "object range read failed with status 500",
      );
    });

    it("an invalid range", async () => {
      const { origin, store } = setup();

      await expect(store.readRange(KEY, 0, 0)).rejects.toThrow("maximumBytes");
      expect(origin.requests).toEqual([]);
    });
  });

  describe("delete", () => {
    it.each([
      ["a stored object", 204],
      ["an object already removed", 404],
    ])("%s", async (_example, code) => {
      const { origin, store } = setup(status(code));

      await store.delete(KEY);

      expect(origin.requests).toEqual([sent("DELETE")]);
    });

    it("an origin that fails", async () => {
      const { store } = setup(status(500));

      await expect(store.delete(KEY)).rejects.toThrow("object delete failed with status 500");
    });
  });

  describe("copyObject", () => {
    const source = "staging/org/asset/session/image.png";
    const copySource = "/meltiply-assets/staging/org/asset/session/image.png";
    const copied = () => xml("<CopyObjectResult><ETag>e</ETag></CopyObjectResult>");

    it("a promotion with every condition", async () => {
      const { origin, store } = setup(status(404), copied(), head());

      const result = await store.copyObject(source, KEY, {
        contentType: "image/png",
        ifDestinationAbsent: true,
        ifSourceEtagMatches: '"staged-etag"',
      });

      expect(result).toEqual(metadata);
      expect(origin.requests).toEqual([
        sent("HEAD"),
        sent("PUT", PATH, {
          "content-type": "image/png",
          "if-none-match": "*",
          "x-amz-copy-source": copySource,
          "x-amz-copy-source-if-match": '"staged-etag"',
          "x-amz-metadata-directive": "REPLACE",
        }),
        sent("HEAD"),
      ]);
    });

    it("a copy with no conditions", async () => {
      const { origin, store } = setup(copied(), head());

      await store.copyObject(source, KEY);

      expect(origin.requests).toEqual([
        sent("PUT", PATH, { "x-amz-copy-source": copySource }),
        sent("HEAD"),
      ]);
    });

    it("a destination that already exists", async () => {
      const { origin, store } = setup(head());

      expect(await store.copyObject(source, KEY, { ifDestinationAbsent: true })).toEqual(null);
      expect(origin.requests).toEqual([sent("HEAD")]);
    });

    it.each([404, 409, 412])("a copy answered %i", async (code) => {
      const { store } = setup(status(code));

      expect(await store.copyObject(source, KEY)).toEqual(null);
    });

    it("an origin that fails", async () => {
      const { store } = setup(status(500));

      await expect(store.copyObject(source, KEY)).rejects.toThrow(
        "object copy failed with status 500",
      );
    });

    it.each([
      ["an error inside a 200", "<CopyObjectResult><Code>InternalError</Code></CopyObjectResult>"],
      ["an unrelated 200", "<Ok/>"],
    ])("%s", async (_example, body) => {
      const { store } = setup(xml(body));

      await expect(store.copyObject(source, KEY)).rejects.toThrow(
        "object copy returned an S3 error or malformed result",
      );
    });
  });

  describe("createMultipartUpload", () => {
    it("a new upload with an escaped ID", async () => {
      const { origin, store } = setup(xml("<UploadId>a&amp;&lt;&gt;&quot;&apos;b</UploadId>"));

      const upload = await store.createMultipartUpload(KEY, "video/mp4");

      expect(upload.uploadId).toEqual(`a&<>"'b`);
      expect(origin.requests).toEqual([
        sent("POST", `${PATH}?uploads=`, { "content-type": "video/mp4" }),
      ]);
    });

    it.each([
      [
        "an answer with no upload ID",
        xml("<InitiateMultipartUploadResult/>"),
        "multipart upload creation returned no UploadId",
      ],
      ["an origin that fails", status(500), "multipart upload creation failed with status 500"],
    ])("%s", async (_example, answer, message) => {
      const { store } = setup(answer);

      await expect(store.createMultipartUpload(KEY, "video/mp4")).rejects.toThrow(message);
    });
  });

  describe("resumeMultipartUpload", () => {
    const resume = (store: S3ObjectStore) => store.resumeMultipartUpload(KEY, "upload-9");
    const partUrl = `${PATH}?partNumber=1&uploadId=upload-9`;
    const uploadUrl = `${PATH}?uploadId=upload-9`;
    const part = () => new Response(null, { headers: { etag: '"part-etag"' } });
    const done = () => xml("<CompleteMultipartUploadResult/>");

    const view = new Uint8Array([0, 97, 98, 99, 0]);

    it.each([
      ["a typed array view", view.subarray(1, 4)],
      ["a data view", new DataView(view.buffer, 1, 3)],
      ["a buffer", new TextEncoder().encode("abc").slice().buffer],
      ["a blob", new Blob(["abc"])],
    ])("a part from %s", async (_example, value) => {
      const { origin, store } = setup(part());

      expect(await resume(store).uploadPart(1, value)).toEqual({
        etag: "part-etag",
        partNumber: 1,
      });
      expect(origin.requests).toEqual([{ ...sent("PUT", partUrl), body: "abc" }]);
      expect(origin.signatures.map((signature) => signature.payloadHash)).toEqual([
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ]);
    });

    it.each([
      ["no ETag", status(200), "multipart part upload returned no ETag"],
      ["a failure", status(500), "multipart part upload failed with status 500"],
    ])("a part answered with %s", async (_example, answer, message) => {
      const { store } = setup(answer);

      await expect(resume(store).uploadPart(1, new Uint8Array([1]))).rejects.toThrow(message);
    });

    it("a completion", async () => {
      const { origin, store } = setup(done(), head());

      const result = await resume(store).complete([{ etag: "a<&>", partNumber: 1 }]);

      expect(result).toEqual(metadata);
      expect(origin.requests).toEqual([
        {
          ...sent("POST", uploadUrl, { "content-type": "application/xml" }),
          body: "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>a&lt;&amp;&gt;</ETag></Part></CompleteMultipartUpload>",
        },
        sent("HEAD"),
      ]);
    });

    it.each([
      ["a failure", [status(500)], "multipart upload completion failed with status 500"],
      [
        "an error inside a 200",
        [xml("<Error><Code>InvalidPart</Code></Error>")],
        "returned an S3 error or malformed result",
      ],
      [
        "no object afterwards",
        [done(), status(404)],
        "completed multipart upload produced no object",
      ],
    ])("a completion with %s", async (_example, answers, message) => {
      const { store } = setup(...answers);

      await expect(resume(store).complete([])).rejects.toThrow(message);
    });

    it.each([
      ["an open upload", 204],
      ["an upload already gone", 404],
    ])("an abort of %s", async (_example, code) => {
      const { origin, store } = setup(status(code));

      await resume(store).abort();

      expect(origin.requests).toEqual([sent("DELETE", uploadUrl)]);
    });

    it("an abort the origin fails", async () => {
      const { store } = setup(status(500));

      await expect(resume(store).abort()).rejects.toThrow(
        "multipart upload abort failed with status 500",
      );
    });
  });
});

describe("S3SigV4Signer", () => {
  const request = {
    contentLength: 42,
    contentType: "image/png",
    expiresInSeconds: 900,
    key: "org one/asset/image.png",
  };

  it("path-style addressing in the configured region", async () => {
    expect(await new S3SigV4Signer(options).signUpload(request)).toEqual(
      "https://objects.example.com/meltiply-assets/org%20one/asset/image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260718%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=9c928fa459487e7e8a556582aecd0592a8f431ca977464940110379f4b6ddcad&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
    );
  });

  it("virtual-host addressing", async () => {
    const signer = new S3SigV4Signer({ ...options, forcePathStyle: false });

    expect(await signer.signDownload({ expiresInSeconds: 60, key: KEY })).toEqual(
      "https://meltiply-assets.objects.example.com/org/asset/image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260718%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=60&X-Amz-Signature=4e8de84090297279c47f1ad35b7f8d7f01c3a25a756adf0cab704d85e7e94018&X-Amz-SignedHeaders=host",
    );
  });

  it("no region", async () => {
    const { region: _omitted, ...unregioned } = options;

    const url = await new S3SigV4Signer(unregioned).signDownload({ expiresInSeconds: 1, key: KEY });

    expect(new URL(url).searchParams.get("X-Amz-Credential")).toEqual(
      "AKIAEXAMPLE/20260718/us-east-1/s3/aws4_request",
    );
  });

  it("a plain-http endpoint outside development", () => {
    expect(() => new S3SigV4Signer({ ...options, endpoint: "http://objects.example.com" })).toThrow(
      new TypeError(
        "endpoint must use HTTPS unless it is loopback-only or insecure endpoints are explicitly allowed",
      ),
    );
  });

  it("a plain-http endpoint that is allowed", () => {
    const insecure = { ...options, allowInsecureEndpoint: true, endpoint: "http://minio:9000" };

    expect(() => new S3SigV4Signer(insecure)).not.toThrow();
  });
});
