import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMutationKey,
  createMutationKeyTracker,
  mutationFingerprint,
} from "./mutation-idempotency";

describe("mutation idempotency", () => {
  it("uses secure random values when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });

    expect(createMutationKey(null, getRandomValues)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it("reuses one key for equivalent retries until success clears it", () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("mutation-key-1")
      .mockReturnValueOnce("mutation-key-2")
      .mockReturnValueOnce("mutation-key-3");
    const tracker = createMutationKeyTracker(createKey);

    expect(tracker.keyFor({ body: { text: "Launch", title: "Note" } })).toBe("mutation-key-1");
    expect(tracker.keyFor({ body: { title: "Note", text: "Launch" } })).toBe("mutation-key-1");
    expect(tracker.keyFor({ body: { text: "Changed", title: "Note" } })).toBe("mutation-key-2");

    tracker.clear();
    expect(tracker.keyFor({ body: { text: "Changed", title: "Note" } })).toBe("mutation-key-3");
    expect(createKey).toHaveBeenCalledTimes(3);
  });

  it("keeps concurrent mutations on independent keys until each settles", () => {
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("key-a")
      .mockReturnValueOnce("key-b")
      .mockReturnValueOnce("key-c");
    const tracker = createMutationKeyTracker(createKey);

    const first = { post_id: "post-1", text: "First" };
    const second = { post_id: "post-2", text: "Second" };

    // Interleaved attempts of two in-flight mutations: each fingerprint keeps
    // its own key, so neither overwrites the other.
    expect(tracker.keyFor(first)).toBe("key-a");
    expect(tracker.keyFor(second)).toBe("key-b");
    expect(tracker.keyFor(first)).toBe("key-a");
    expect(tracker.keyFor(second)).toBe("key-b");
    expect(createKey).toHaveBeenCalledTimes(2);

    // Settling the first mutation clears only its fingerprint: the second
    // mutation's retry still reuses its original key.
    tracker.clear(mutationFingerprint(first));
    expect(tracker.keyFor(second)).toBe("key-b");
    expect(createKey).toHaveBeenCalledTimes(2);

    // A fresh attempt of the settled payload mints a new key.
    expect(tracker.keyFor(first)).toBe("key-c");
    expect(createKey).toHaveBeenCalledTimes(3);
  });

  it("evicts the oldest fingerprint once the active map reaches its cap", () => {
    const createKey = vi.fn<() => string>(() => "key");
    const tracker = createMutationKeyTracker(createKey);

    for (let index = 0; index < 64; index += 1) {
      tracker.keyFor({ index });
    }
    expect(createKey).toHaveBeenCalledTimes(64);

    // The 65th distinct fingerprint evicts the oldest entry; re-asking for it
    // mints a fresh key instead of resurrecting the evicted one.
    tracker.keyFor({ index: 64 });
    tracker.keyFor({ index: 0 });
    expect(createKey).toHaveBeenCalledTimes(66);
  });
});
