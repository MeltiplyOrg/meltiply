import { InvalidRequestError, NotFoundError, StorageUnavailableError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { toStorageError } from "../src/object-store";
import { FakeObjectStore, METADATA } from "./fake-object-store";

const KEY = "org/asset/photo.png";

type Call = (store: FakeObjectStore) => Effect.Effect<unknown, unknown>;

function setup(failure?: unknown) {
  const store = new FakeObjectStore();
  store.failure = failure;
  return { store };
}

describe("toStorageError", () => {
  it.each([
    ["a bad argument", new TypeError("bad key"), new InvalidRequestError({ message: "bad key" })],
    ["a bad range", new RangeError("bad range"), new InvalidRequestError({ message: "bad range" })],
    ["a store failure", new Error("down"), new StorageUnavailableError({ message: "down" })],
    ["a thrown string", "boom", new StorageUnavailableError({ message: "fallback" })],
  ])("%s", (_example, cause, error) => {
    expect(toStorageError(cause, "fallback")).toEqual(error);
  });
});

describe("EffectObjectStore", () => {
  it.each<[string, Call, unknown, unknown[]]>([
    ["headEffect", (s: FakeObjectStore) => s.headEffect(KEY), METADATA, [["head", KEY]]],
    [
      "getMetadataEffect",
      (s: FakeObjectStore) => s.getMetadataEffect(KEY),
      METADATA,
      [["head", KEY]],
    ],
    ["deleteEffect", (s: FakeObjectStore) => s.deleteEffect(KEY), undefined, [["delete", KEY]]],
    [
      "readRangeEffect",
      (s: FakeObjectStore) => s.readRangeEffect(KEY, 4, 8),
      new Uint8Array([1, 2]),
      [["readRange", KEY, 4, 8]],
    ],
    [
      "readPrefixEffect",
      (s: FakeObjectStore) => s.readPrefixEffect(KEY, 8),
      new Uint8Array([1, 2]),
      [["readRange", KEY, 0, 8]],
    ],
  ])("%s", async (_method, call, result, calls) => {
    const { store } = setup();

    expect(await Effect.runPromise(call(store))).toEqual(result);
    expect(store.calls).toEqual(calls);
  });

  it("getMetadataEffect on a missing object", async () => {
    const { store } = setup();
    store.object = null;

    expect(await Effect.runPromise(Effect.flip(store.getMetadataEffect(KEY)))).toEqual(
      new NotFoundError({ message: `Storage object not found: ${KEY}` }),
    );
  });

  it.each<[string, Call, string]>([
    ["headEffect", (s: FakeObjectStore) => s.headEffect(KEY), "Failed to query object metadata"],
    [
      "deleteEffect",
      (s: FakeObjectStore) => s.deleteEffect(KEY),
      "Failed to delete storage object",
    ],
    [
      "readRangeEffect",
      (s: FakeObjectStore) => s.readRangeEffect(KEY, 0, 1),
      "Failed to read storage object range",
    ],
    [
      "createMultipartUploadEffect",
      (s: FakeObjectStore) => s.createMultipartUploadEffect(KEY, "a/b"),
      "Failed to initiate multipart upload",
    ],
    [
      "resumeMultipartUploadEffect",
      (s: FakeObjectStore) => s.resumeMultipartUploadEffect(KEY, "u"),
      "Failed to resume multipart upload",
    ],
  ])("%s while the store is down", async (_method, call, message) => {
    const { store } = setup("down");

    const error = await Effect.runPromise(Effect.flip(call(store)));

    expect(error).toEqual(new StorageUnavailableError({ message }));
  });

  it("resumeMultipartUploadEffect with a rejected upload ID", async () => {
    const { store } = setup(new TypeError("bad upload id"));

    const error = await Effect.runPromise(Effect.flip(store.resumeMultipartUploadEffect(KEY, "u")));

    expect(error).toEqual(new InvalidRequestError({ message: "bad upload id" }));
  });

  it("createMultipartUploadEffect driven to completion", async () => {
    const { store } = setup();

    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const upload = yield* store.createMultipartUploadEffect(KEY, "video/mp4");
        const part = yield* upload.uploadPart(1, new Uint8Array([1]));
        const metadata = yield* upload.complete([part]);
        yield* upload.abort();
        return metadata;
      }),
    );

    expect(completed).toEqual(METADATA);
    expect(store.calls).toEqual([
      ["createMultipartUpload", KEY, "video/mp4"],
      ["uploadPart", "upload-new", 1],
      ["complete", "upload-new", [{ etag: "part-etag", partNumber: 1 }]],
      ["abort", "upload-new"],
    ]);
  });

  it("resumeMultipartUploadEffect", async () => {
    const { store } = setup();

    const upload = await Effect.runPromise(store.resumeMultipartUploadEffect(KEY, "upload-9"));

    expect(upload.uploadId).toEqual("upload-9");
  });

  it.each([
    [
      "an abort that fails",
      "abort",
      "down",
      new StorageUnavailableError({ message: "Failed to abort multipart upload" }),
    ],
    [
      "a completion that fails",
      "complete",
      "down",
      new StorageUnavailableError({ message: "Failed to complete multipart upload" }),
    ],
    [
      "a part rejected as invalid",
      "uploadPart",
      new TypeError("bad part"),
      new InvalidRequestError({ message: "bad part" }),
    ],
    [
      "a part the store drops",
      "uploadPart",
      "down",
      new StorageUnavailableError({ message: "Failed to upload multipart part" }),
    ],
  ] as const)("%s", async (_example, operation, failure, expected) => {
    const { store } = setup();
    const upload = await Effect.runPromise(store.resumeMultipartUploadEffect(KEY, "u"));
    store.failure = failure;
    const calls: Record<typeof operation, Effect.Effect<unknown, unknown>> = {
      abort: upload.abort(),
      complete: upload.complete([]),
      uploadPart: upload.uploadPart(1, new Uint8Array()),
    };

    const error = await Effect.runPromise(Effect.flip(calls[operation]));

    expect(error).toEqual(expected);
  });
});
