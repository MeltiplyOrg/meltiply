import { InvalidRequestError } from "@meltiply/domain";
import { Effect } from "effect";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { R2SigV4Signer } from "../src/r2";
import { SigV4Signer, type SigV4SignerOptions } from "../src/sigv4";

const NOW = new Date("2026-07-18T12:34:56Z");
const HOST = "https://account-id.r2.cloudflarestorage.com";
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const options: SigV4SignerOptions = {
  accessKeyId: "access-key",
  addressing: "path",
  bucket: "private-assets",
  endpoint: HOST,
  now: () => NOW,
  region: "auto",
  secretAccessKey: "secret-key",
};

const urlSigner = (now = () => NOW) =>
  new R2SigV4Signer({
    accessKeyId: "access-key",
    accountId: "account-id",
    bucket: "private-assets",
    now,
    secretAccessKey: "secret-key",
  });

const upload = {
  contentLength: 42,
  contentType: "video/mp4",
  expiresInSeconds: 900,
  key: "org/asset/clip.mp4",
};
const part = { ...upload, partNumber: 3, uploadId: "opaque/native+id" };
const download = { expiresInSeconds: 900, key: "org/asset/clip.mp4" };
const write = {
  expiresInSeconds: 900,
  key: "staging/org/asset/processing",
  requiredHeaders: { "If-None-Match": " * " },
};
const secondsFromNow = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const param = (url: string, name: string) => new URL(url).searchParams.get(name);

beforeAll(async () => {
  await urlSigner().signUpload(upload);
  await new SigV4Signer(options).prepareRequest({ key: "org/a", method: "GET" });
});

describe("SigV4Signer", () => {
  describe("constructor", () => {
    it.each([
      ["accessKeyId", { accessKeyId: " " }],
      ["region", { region: "" }],
      ["secretAccessKey", { secretAccessKey: "" }],
    ])("a blank %s", (name, override) => {
      expect(() => new SigV4Signer({ ...options, ...override })).toThrow(
        new TypeError(`${name} is required`),
      );
    });

    it.each([
      ["plain http on localhost", "http://localhost:9000"],
      ["plain http on the IPv4 loopback", "http://127.0.0.1:9000"],
      ["plain http on the IPv6 loopback", "http://[::1]:9000"],
    ])("%s", (_example, endpoint) => {
      expect(() => new SigV4Signer({ ...options, endpoint })).not.toThrow();
    });

    it("plain http on a remote host", () => {
      expect(() => new SigV4Signer({ ...options, endpoint: "http://storage.example.com" })).toThrow(
        new TypeError(
          "endpoint must use HTTPS unless it is loopback-only or insecure endpoints are explicitly allowed",
        ),
      );
    });

    it("plain http on a remote host that is explicitly allowed", () => {
      const insecure = { ...options, allowInsecureEndpoint: true, endpoint: "http://minio:9000" };

      expect(() => new SigV4Signer(insecure)).not.toThrow();
    });

    it.each([
      ["a username", "https://user@storage.example.com"],
      ["a password", "https://:pass@storage.example.com"],
      ["a path", "https://storage.example.com/s3"],
      ["a query", "https://storage.example.com?a=1"],
      ["a fragment", "https://storage.example.com#a"],
    ])("an endpoint with %s", (_example, endpoint) => {
      expect(() => new SigV4Signer({ ...options, endpoint })).toThrow(
        new TypeError("endpoint must not include credentials, a path, query, or fragment"),
      );
    });

    it("a bucket that is not one path segment", () => {
      expect(() => new SigV4Signer({ ...options, bucket: "a/b" })).toThrow(
        "bucket must be a non-empty path segment",
      );
    });

    it.each([
      ["only slashes", "///", "endpointPathPrefix must not be only slashes"],
      ["129 characters", "a".repeat(129), "endpointPathPrefix must be at most 128 characters"],
      ["a parent segment", "a/../b", "endpointPathPrefix must be a non-empty path segment"],
    ])("a path prefix of %s", (_example, endpointPathPrefix, message) => {
      expect(() => new SigV4Signer({ ...options, endpointPathPrefix })).toThrow(message);
    });
  });

  describe("objectUrl", () => {
    it.each([
      ["no prefix or padding", {}, `${HOST}/private-assets/org/a%20b`],
      [
        "a prefix of 128 characters",
        { endpointPathPrefix: "a".repeat(128) },
        `${HOST}/${"a".repeat(128)}/private-assets/org/a%20b`,
      ],
      ["a blank prefix", { endpointPathPrefix: "  " }, `${HOST}/private-assets/org/a%20b`],
      [
        "a prefix wrapped in 100000 slashes",
        { endpointPathPrefix: `${"/".repeat(100_000)}cdn-cgi/r2${"/".repeat(100_000)}` },
        `${HOST}/cdn-cgi/r2/private-assets/org/a%20b`,
      ],
      [
        "virtual-host addressing",
        { addressing: "virtual" },
        "https://private-assets.account-id.r2.cloudflarestorage.com/org/a%20b",
      ],
    ] as const)("%s", (_example, override, url) => {
      expect(new SigV4Signer({ ...options, ...override }).objectUrl("org/a b").toString()).toEqual(
        url,
      );
    });

    it("a query", () => {
      const url = new SigV4Signer(options).objectUrl("org/a", new Map([["uploads", ""]]));

      expect(url.toString()).toEqual(`${HOST}/private-assets/org/a?uploads=`);
    });
  });

  describe("copySource", () => {
    it("a key under a path prefix", () => {
      const signer = new SigV4Signer({ ...options, endpointPathPrefix: "r2" });

      expect(signer.copySource("org/a b")).toEqual("/r2/private-assets/org/a%20b");
    });
  });

  describe("prepareRequest", () => {
    it("a ranged read with a query and a padded header", async () => {
      const signed = await new SigV4Signer(options).prepareRequest({
        headers: { Range: "bytes=0-2", "X-Meta": "  a   b " },
        key: "org/asset/clip.mp4",
        method: "GET",
        query: new Map([
          ["uploadId", "u/1"],
          ["partNumber", "1"],
        ]),
      });

      expect({ url: signed.url.toString(), headers: signed.headers }).toEqual({
        url: `${HOST}/private-assets/org/asset/clip.mp4?uploadId=u%2F1&partNumber=1`,
        headers: {
          Authorization:
            "AWS4-HMAC-SHA256 Credential=access-key/20260718/auto/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date;x-meta, Signature=04e73a2785dc9a9ee2ef6dbc20fd89ff5159184983b3a58bdf65174d1c4e503e",
          host: "account-id.r2.cloudflarestorage.com",
          range: "bytes=0-2",
          "x-amz-content-sha256": EMPTY_HASH,
          "x-amz-date": "20260718T123456Z",
          "x-meta": "a b",
        },
      });
    });

    it("a request with a body", async () => {
      const signed = await new SigV4Signer(options).prepareRequest({
        body: new TextEncoder().encode("abc"),
        key: "org/a",
        method: "PUT",
      });

      expect(signed.headers["x-amz-content-sha256"]).toEqual(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });
  });

  describe("prepareBucketRequest", () => {
    it.each([
      ["path addressing", "path", `${HOST}/private-assets`],
      [
        "virtual-host addressing",
        "virtual",
        "https://private-assets.account-id.r2.cloudflarestorage.com/",
      ],
    ] as const)("%s", async (_example, addressing, url) => {
      const signed = await new SigV4Signer({ ...options, addressing }).prepareBucketRequest("HEAD");

      expect(signed.url.toString()).toEqual(url);
    });
  });
});

describe("SigV4UrlSigner", () => {
  describe("signUpload", () => {
    it("a key with spaces", async () => {
      const request = { ...upload, key: "org one/asset/clip final.mp4" };

      expect(await urlSigner().signUpload(request)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org%20one/asset/clip%20final.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=02146461c49e3d6579f7718e2caacbc1424af5cada1ca7c8879f62f1d84abbc2&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
      );
    });

    it("a deadline inside the requested lifetime, with a clock that moves", async () => {
      let reads = 0;
      const signer = urlSigner(() => secondsFromNow(reads++));

      expect(await signer.signUpload({ ...upload, expiresAt: secondsFromNow(200) })).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=200&X-Amz-Signature=5b6313324aed95084522738dbfcdf28919eba5c73263cc867d7fa2039c03bc47&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
      );
    });

    it("a deadline past the requested lifetime", async () => {
      const request = { ...upload, expiresAt: secondsFromNow(3600), expiresInSeconds: 60 };

      expect(await urlSigner().signUpload(request)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=60&X-Amz-Signature=f9be58cc0be4fd10bd9c3bef26cdd6682a46ba32bdc650308a5414b148a12e91&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
      );
    });

    it.each([
      ["an elapsed deadline", -1],
      ["a deadline half a second away", 0.5],
      ["a deadline of now", 0],
    ])("%s", async (_example, seconds) => {
      const request = { ...upload, expiresAt: secondsFromNow(seconds) };

      await expect(urlSigner().signUpload(request)).rejects.toThrow(
        new TypeError("expiresAt has already elapsed"),
      );
    });

    it("a deadline one second away", async () => {
      const url = await urlSigner().signUpload({ ...upload, expiresAt: secondsFromNow(1) });

      expect(param(url, "X-Amz-Expires")).toEqual("1");
    });

    it.each([
      [
        "a content length of zero",
        { contentLength: 0 },
        "contentLength must be a positive safe integer",
      ],
      [
        "a fractional content length",
        { contentLength: 1.5 },
        "contentLength must be a positive safe integer",
      ],
      ["a blank content type", { contentType: " " }, "contentType is required"],
      ["a traversal key", { key: "org/../clip.mp4" }, "key must be a non-empty path segment"],
    ])("%s", async (_example, override, message) => {
      await expect(urlSigner().signUpload({ ...upload, ...override })).rejects.toThrow(message);
    });
  });

  describe("signDownload", () => {
    it("an inline preview", async () => {
      expect(await urlSigner().signDownload(download)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=01570b20e3568cfab55e063c6bce1c0f97f3b257f8a5a9ddede82ea928881bdd&X-Amz-SignedHeaders=host",
      );
    });

    it("an attachment with a quote in its name", async () => {
      const request = { ...download, downloadFilename: 'clip".mp4' };

      expect(await urlSigner().signDownload(request)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=e7bca2c0a3640181b21aa1bc88e5ea1cee4f7cfac9807b569cdd9c80b0b961bc&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%3D%22clip_.mp4%22&response-content-type=application%2Foctet-stream",
      );
    });

    it("a key with reserved characters", async () => {
      const request = { ...download, key: "org/asset/clip!(1)'*.mp4" };

      expect(await urlSigner().signDownload(request)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip%21%281%29%27%2A.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=92adaca1f5042a840bd30be9205694217fe17eee158784a26f6ef0f659e39cf2&X-Amz-SignedHeaders=host",
      );
    });

    it.each([
      ["a name over 180 characters", "a".repeat(181), `attachment; filename="${"a".repeat(180)}"`],
      ["a name outside ASCII with a path", "dir/é\n.png", 'attachment; filename="dir_é_.png"'],
    ])("%s", async (_example, downloadFilename, disposition) => {
      const url = await urlSigner().signDownload({ ...download, downloadFilename });

      expect(param(url, "response-content-disposition")).toEqual(disposition);
    });

    it("a blank attachment name", async () => {
      await expect(
        urlSigner().signDownload({ ...download, downloadFilename: " " }),
      ).rejects.toThrow(new TypeError("downloadFilename is required"));
    });

    it.each([
      ["one second", 1],
      ["seven days", 604_800],
    ])("a lifetime of %s", async (_example, expiresInSeconds) => {
      const url = await urlSigner().signDownload({ ...download, expiresInSeconds });

      expect(param(url, "X-Amz-Expires")).toEqual(String(expiresInSeconds));
    });

    it.each([
      ["zero seconds", 0],
      ["over seven days", 604_801],
      ["a fraction of a second", 1.5],
    ])("a lifetime of %s", async (_example, expiresInSeconds) => {
      await expect(urlSigner().signDownload({ ...download, expiresInSeconds })).rejects.toThrow(
        new TypeError("expiresInSeconds must be between 1 and 604800"),
      );
    });
  });

  describe("signMultipartPart", () => {
    it("an opaque upload ID", async () => {
      expect(await urlSigner().signMultipartPart(part)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=c5362e776621fb4bb65281d3be138f940145a0a99990ef02bb9d56d98a8dd9aa&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&partNumber=3&uploadId=opaque%2Fnative%2Bid",
      );
    });

    it("the last part number", async () => {
      const request = { ...part, partNumber: 10_000, uploadId: "upload" };

      expect(await urlSigner().signMultipartPart(request)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=88add5140dbf7bff37036e74ebd231f5f196ba9760d0f054ccd5858bd666ef0b&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&partNumber=10000&uploadId=upload",
      );
    });

    it.each([
      ["part zero", { partNumber: 0 }, "partNumber must be between 1 and 10000"],
      ["part 10001", { partNumber: 10_001 }, "partNumber must be between 1 and 10000"],
      ["a fractional part", { partNumber: 1.5 }, "partNumber must be between 1 and 10000"],
      ["a blank upload ID", { uploadId: " " }, "uploadId is required"],
    ])("%s", async (_example, override, message) => {
      await expect(urlSigner().signMultipartPart({ ...part, ...override })).rejects.toThrow(
        message,
      );
    });
  });

  describe("signObjectWrite", () => {
    it("a create-only header", async () => {
      expect(await urlSigner().signObjectWrite(write)).toEqual(
        "https://account-id.r2.cloudflarestorage.com/private-assets/staging/org/asset/processing?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=8e8714363d1735469b34e0ada8bd8694577ac8975aadcd34ba707cadac53755b&X-Amz-SignedHeaders=host%3Bif-none-match",
      );
    });

    it.each([
      ["no required headers", {}, "requiredHeaders must not be empty"],
      ["a host header", { Host: "evil.example.com" }, "requiredHeaders must not override host"],
      [
        "a header name with spaces",
        { "if none match": "*" },
        "requiredHeaders contains an invalid header name",
      ],
      ["a blank header value", { "x-a": " " }, 'requiredHeaders["x-a"] is required'],
    ])("%s", async (_example, requiredHeaders: Record<string, string>, message) => {
      await expect(urlSigner().signObjectWrite({ ...write, requiredHeaders })).rejects.toThrow(
        message,
      );
    });
  });

  describe.each(["signUploadEffect", "signDownloadEffect", "signMultipartPartEffect"] as const)(
    "%s",
    (method) => {
      it("a signed request", async () => {
        expect(await Effect.runPromise(urlSigner()[method](part))).toEqual(
          expect.stringMatching(/X-Amz-Signature=[0-9a-f]{64}/),
        );
      });

      it("an unsignable request", async () => {
        const signer = urlSigner();
        const invalid = { ...part, expiresInSeconds: 0 };

        const error = await Effect.runPromise(Effect.flip(signer[method](invalid)));

        expect(error).toEqual(
          new InvalidRequestError({ message: "expiresInSeconds must be between 1 and 604800" }),
        );
      });
    },
  );

  it("concurrent parts derive one signing key for the day", async () => {
    let now = NOW;
    const signer = urlSigner(() => now);
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await Promise.all(
      [1, 2, 3].map((partNumber) => signer.signMultipartPart({ ...part, partNumber })),
    );
    const firstDay = importKey.mock.calls.length;
    now = new Date("2026-07-19T00:00:00Z");
    await signer.signUpload(upload);

    expect([firstDay, importKey.mock.calls.length]).toEqual([5, 10]);
    importKey.mockRestore();
  });
});
