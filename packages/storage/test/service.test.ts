import { InvalidRequestError, StorageUnavailableError } from "@meltiply/domain";
import { Effect, type Layer } from "effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  createStorageServiceLive,
  createStorageServiceTest,
  StorageService,
  type CreateStorageServiceLiveOptions,
  type StorageServiceShape,
} from "../src/service";
import type { ObjectUrlSigner } from "../src/object-store";
import { FakeObjectStore, METADATA } from "./fake-object-store";

const KEY = "org/asset/photo.png";
const download = { expiresInSeconds: 60, key: KEY };
const upload = { ...download, contentLength: 10, contentType: "image/png" };
const part = { ...upload, partNumber: 2, uploadId: "upload-1" };

class FakeSigner implements ObjectUrlSigner {
  readonly signed: unknown[][] = [];
  failure: unknown;

  private async sign(kind: string, request: unknown) {
    if (this.failure !== undefined) throw this.failure;
    this.signed.push([kind, request]);
    return `https://signer.test/${kind}`;
  }

  signDownload = (request: unknown) => this.sign("download", request);
  signMultipartPart = (request: unknown) => this.sign("part", request);
  signUpload = (request: unknown) => this.sign("upload", request);
}

function setup(options: CreateStorageServiceLiveOptions = {}) {
  const store = new FakeObjectStore();
  const signer = new FakeSigner();
  const layer = createStorageServiceLive({ signer, store, ...options });
  return { store, signer, layer };
}

type Operation = (storage: StorageServiceShape) => Effect.Effect<unknown, unknown>;

const run = (layer: Layer.Layer<StorageService>, operation: Operation) =>
  Effect.runPromise(
    StorageService.pipe(Effect.flatMap(operation), Effect.provide(layer)) as Effect.Effect<unknown>,
  );

const failureOf = (layer: Layer.Layer<StorageService>, operation: Operation) =>
  run(layer, (storage) => Effect.flip(operation(storage)));

const uploadId = (effect: Effect.Effect<{ uploadId: string }, unknown>) =>
  effect.pipe(Effect.map((result) => result.uploadId));

const storeOperations: [string, Operation, unknown, unknown[]][] = [
  [
    "createMultipartUpload",
    (s) => uploadId(s.createMultipartUpload(KEY, "a/b")),
    "upload-new",
    ["createMultipartUpload", KEY, "a/b"],
  ],
  ["delete", (s) => s.delete(KEY), undefined, ["delete", KEY]],
  ["getMetadata", (s) => s.getMetadata(KEY), METADATA, ["head", KEY]],
  ["head", (s) => s.head(KEY), METADATA, ["head", KEY]],
  ["readPrefix", (s) => s.readPrefix(KEY, 8), new Uint8Array([1, 2]), ["readRange", KEY, 0, 8]],
  ["readRange", (s) => s.readRange(KEY, 4, 8), new Uint8Array([1, 2]), ["readRange", KEY, 4, 8]],
  [
    "resumeMultipartUpload",
    (s) => uploadId(s.resumeMultipartUpload(KEY, "u-9")),
    "u-9",
    ["resumeMultipartUpload", KEY, "u-9"],
  ],
];

const signOperations: [string, Operation, string, unknown, string][] = [
  [
    "signDownload",
    (s) => s.signDownload(download),
    "download",
    download,
    "Failed to sign download URL",
  ],
  [
    "signMultipartPart",
    (s) => s.signMultipartPart(part),
    "part",
    part,
    "Failed to sign multipart part URL",
  ],
  ["signUpload", (s) => s.signUpload(upload), "upload", upload, "Failed to sign upload URL"],
];

const notConfigured = new StorageUnavailableError({ message: "Object storage is not configured." });

beforeAll(async () => {
  await run(setup().layer, (s) => s.head(KEY));
});

describe("createStorageServiceLive", () => {
  it.each(storeOperations)("%s", async (_name, operation, result, call) => {
    const { store, layer } = setup();

    expect(await run(layer, operation)).toEqual(result);
    expect(store.calls).toEqual([call]);
  });

  it.each(signOperations)("%s", async (_name, operation, kind, request) => {
    const { signer, layer } = setup();

    expect(await run(layer, operation)).toEqual(`https://signer.test/${kind}`);
    expect(signer.signed).toEqual([[kind, request]]);
  });

  it.each(storeOperations)("%s with no object store", async (_name, operation) => {
    const { layer } = setup({ store: undefined });

    expect(await failureOf(layer, operation)).toEqual(notConfigured);
  });

  it.each(signOperations)("%s with no signer", async (_name, operation) => {
    const { layer } = setup({ signer: undefined });

    expect(await failureOf(layer, operation)).toEqual(notConfigured);
  });

  it("a configured unavailable error", async () => {
    const storageUnavailableError = new StorageUnavailableError({ message: "Uploads are off." });
    const { layer } = setup({ store: undefined, storageUnavailableError });

    expect(await failureOf(layer, (s) => s.head(KEY))).toEqual(storageUnavailableError);
  });

  it.each(signOperations)(
    "%s while the signer is down",
    async (_name, operation, _k, _r, message) => {
      const { signer, layer } = setup();
      signer.failure = "down";

      expect(await failureOf(layer, operation)).toEqual(new StorageUnavailableError({ message }));
    },
  );

  it("a request the signer rejects as invalid", async () => {
    const { signer, layer } = setup();
    signer.failure = new TypeError("bad key");

    expect(await failureOf(layer, (s) => s.signUpload(upload))).toEqual(
      new InvalidRequestError({ message: "bad key" }),
    );
  });

  it("signing with no object store", async () => {
    const { layer } = setup({ store: undefined });

    expect(await run(layer, (s) => s.signDownload(download))).toEqual(
      "https://signer.test/download",
    );
  });
});

const testMetadata = (key: string) => ({
  contentType: "application/octet-stream",
  etag: "mock-etag",
  key,
  size: 1024,
  uploadedAt: new Date("2026-01-01"),
});

const completed = (operation: "createMultipartUpload" | "resumeMultipartUpload"): Operation => {
  return (storage) =>
    Effect.gen(function* () {
      const multipart = yield* storage[operation]("k", "u-1");
      const uploaded = yield* multipart.uploadPart(1, new Uint8Array([1]));
      const metadata = yield* multipart.complete([uploaded]);
      yield* multipart.abort();
      return [multipart.uploadId, uploaded.etag, metadata.etag, metadata.size];
    });
};

describe("createStorageServiceTest", () => {
  it.each<[string, Operation, unknown]>([
    ["getMetadata", (s) => s.getMetadata("k"), testMetadata("k")],
    ["head", (s) => s.head("k"), testMetadata("k")],
    ["delete", (s) => s.delete("k"), undefined],
    ["readPrefix", (s) => s.readPrefix("k", 2), new Uint8Array([0, 1])],
    ["readRange", (s) => s.readRange("k", 0, 2), new Uint8Array([0, 1])],
    [
      "createMultipartUpload",
      completed("createMultipartUpload"),
      ["mock-upload-id", "mock-etag-part-1", "mock-etag-complete", 1024],
    ],
    [
      "resumeMultipartUpload",
      completed("resumeMultipartUpload"),
      ["u-1", "mock-etag-part-1", "mock-etag-resumed", 2048],
    ],
    [
      "signDownload",
      (s) => s.signDownload(download),
      `https://mock-storage.local/download/${KEY}?sig=mock`,
    ],
    [
      "signMultipartPart",
      (s) => s.signMultipartPart(part),
      `https://mock-storage.local/part/${KEY}?partNumber=2&uploadId=upload-1&sig=mock`,
    ],
    [
      "signUpload",
      (s) => s.signUpload(upload),
      `https://mock-storage.local/upload/${KEY}?sig=mock`,
    ],
  ])("the default %s", async (_name, operation, result) => {
    expect(await run(createStorageServiceTest(), operation)).toEqual(result);
  });

  it("an overridden operation", async () => {
    const layer = createStorageServiceTest({ head: () => Effect.succeed(null) });

    expect(await run(layer, (s) => s.head("k"))).toEqual(null);
  });
});
