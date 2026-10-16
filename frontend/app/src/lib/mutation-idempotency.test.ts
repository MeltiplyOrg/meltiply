import { describe, expect, it, vi } from "vite-plus/test";

import { createMutationKey, createMutationKeyTracker } from "./mutation-idempotency";

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
});
