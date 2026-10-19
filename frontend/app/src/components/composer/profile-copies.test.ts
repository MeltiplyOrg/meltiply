import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Post } from "@/types";
import { persistProfileCopies, type ProfileCopy, type ProfileCopyProgress } from "./profile-copies";

const media = vi.hoisted(() => ({ processing: true }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getAsset: () => (media.processing ? Effect.never : Effect.succeed({ status: "ready" })),
  };
});

const saved: Post = {
  analytics: null,
  id: "post-a",
  org_id: "org-a",
  brand_profile_id: "profile-a",
  title: "",
  default_text: "Caption",
  status: "draft",
  revision: 1,
  attachments: [],
  targets: [],
  distributions: [],
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  media.processing = true;
});

describe("profile copy media readiness", () => {
  it("fails a stalled read at the deadline and retries the retained Post once media is ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const timer = new AbortController();
      setTimeout(
        () => timer.abort(new DOMException("Media readiness timed out", "TimeoutError")),
        milliseconds,
      );
      return timer.signal;
    });
    const controller = new AbortController();
    const copies = new Map<string, ProfileCopy>();
    const progress: ProfileCopyProgress[] = [];
    const create = vi.fn(async () => saved);
    const update = vi.fn(async () => saved);
    const schedule = vi.fn(async () => undefined);
    const options = {
      profileIds: ["profile-a"],
      sourceProfileId: "profile-a",
      sourcePostId: null,
      attachments: [{ assetId: "asset-a", name: "image.png", mimeType: "image/png" }],
      sharedContent: "Caption",
      targetsByProfile: new Map([
        ["profile-a", [{ platform_account_id: "channel-a", attachment_ids: null, overrides: {} }]],
      ]),
      scheduledAt: null,
      mode: "now" as const,
      workspaceId: null,
      copies,
      signal: controller.signal,
      create,
      update,
      schedule,
      onProgress: (event: ProfileCopyProgress) => progress.push(event),
    };
    let result: boolean | undefined;
    const pending = persistProfileCopies(options).then((value) => {
      result = value;
    });
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(result).toBe(false);
      expect(progress.at(-1)).toMatchObject({ profileId: "profile-a", phase: "failed" });
      expect(copies.get("profile-a")?.postId).toBe(saved.id);
      expect(schedule).not.toHaveBeenCalled();
      media.processing = false;
      expect(await persistProfileCopies(options)).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(progress.at(-1)).toMatchObject({ profileId: "profile-a", phase: "scheduled" });
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });
});
