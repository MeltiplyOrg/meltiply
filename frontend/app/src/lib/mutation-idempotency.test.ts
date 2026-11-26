import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  createMutationKey,
  createMutationKeyTracker,
  mutationFingerprint,
} from "./mutation-idempotency";

function countingTracker() {
  let issued = 0;
  return createMutationKeyTracker(() => `key-${(issued += 1)}`);
}

const indexes = (count: number) => Array.from({ length: count }, (_, index) => ({ index }));

beforeAll(() => {
  mutationFingerprint({ b: 1, a: 2 });
});

describe("createMutationKey", () => {
  it("a runtime with randomUUID", () => {
    expect(createMutationKey(() => "from-random-uuid")).toEqual("from-random-uuid");
  });

  it("a runtime without randomUUID", () => {
    const sequentialBytes = (bytes: Uint8Array<ArrayBuffer>) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    };

    expect(createMutationKey(null, sequentialBytes)).toEqual(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
  });
});

describe("mutationFingerprint", () => {
  it.each([
    ["keys out of order", { title: "Note", text: "Launch" }, '{"text":"Launch","title":"Note"}'],
    ["objects inside a list", [{ b: 1, a: 2 }], '[{"a":2,"b":1}]'],
    ["a null input", null, "null"],
    ["no input", undefined, "undefined"],
    ["text outside ASCII", "café", '"café"'],
  ])("%s", (_example, input, fingerprint) => {
    expect(mutationFingerprint(input)).toEqual(fingerprint);
  });
});

describe("createMutationKeyTracker", () => {
  it("an equivalent retry", () => {
    const tracker = countingTracker();
    tracker.keyFor({ body: { text: "Launch", title: "Note" } });

    expect(tracker.keyFor({ body: { title: "Note", text: "Launch" } })).toEqual("key-1");
  });

  it("a changed input", () => {
    const tracker = countingTracker();
    tracker.keyFor({ text: "Launch" });

    expect(tracker.keyFor({ text: "Changed" })).toEqual("key-2");
  });

  it("a retry after everything was cleared", () => {
    const tracker = countingTracker();
    tracker.keyFor({ text: "Launch" });

    tracker.clear();

    expect(tracker.keyFor({ text: "Launch" })).toEqual("key-2");
  });

  it("clearing one of two pending mutations", () => {
    const tracker = countingTracker();
    tracker.keyFor({ post: 1 });
    tracker.keyFor({ post: 2 });

    tracker.clear(mutationFingerprint({ post: 1 }));

    expect([tracker.keyFor({ post: 2 }), tracker.keyFor({ post: 1 })]).toEqual(["key-2", "key-3"]);
  });

  it("the oldest of 64 pending mutations", () => {
    const tracker = countingTracker();
    for (const input of indexes(64)) tracker.keyFor(input);

    expect(tracker.keyFor({ index: 0 })).toEqual("key-1");
  });

  it("the oldest of 65 mutations", () => {
    const tracker = countingTracker();
    for (const input of indexes(65)) tracker.keyFor(input);

    expect(tracker.keyFor({ index: 0 })).toEqual("key-66");
  });
});
