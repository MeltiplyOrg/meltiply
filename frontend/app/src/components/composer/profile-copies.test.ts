import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { Asset, CreatePostInput, Post, SchedulePostInput, UpdatePostInput } from "@/types";
import { persistProfileCopies, type ProfileCopy, type ProfileCopyProgress } from "./profile-copies";

const saved: Post = {
  analytics: null,
  attachments: [],
  brand_profile_id: "profile-a",
  created_at: "2026-10-01T10:00:00.000Z",
  default_text: "Caption",
  distribution_analytics: [],
  distributions: [],
  id: "post-a",
  org_id: "org-a",
  queue_membership: null,
  revision: 1,
  status: "draft",
  targets: [],
  title: "",
  updated_at: "2026-10-01T10:00:00.000Z",
};

function setup(
  options: {
    mode?: "draft" | "now" | "schedule";
    readAsset?: (workspaceId: string | null, assetId: string) => Effect.Effect<Asset, unknown>;
    readinessTimeoutMs?: number;
  } = {},
) {
  const created: CreatePostInput[] = [];
  const updated: { id: string; input: UpdatePostInput }[] = [];
  const scheduled: { id: string; input: SchedulePostInput }[] = [];
  const progress: ProfileCopyProgress[] = [];
  const copies = new Map<string, ProfileCopy>();
  const controller = new AbortController();

  const run = () =>
    persistProfileCopies({
      attachments: [{ assetId: "asset-a", mimeType: "image/png", name: "image.png" }],
      copies,
      create: async (input) => {
        created.push(input);
        return saved;
      },
      mode: options.mode ?? "now",
      onProgress: (event) => progress.push(event),
      profileIds: ["profile-a"],
      publicationTargetsByProfile: new Map([
        ["profile-a", [{ attachment_ids: null, platform_account_id: "channel-a" }]],
      ]),
      readAsset: options.readAsset ?? (() => Effect.succeed({ status: "ready" } as Asset)),
      readinessPollIntervalMs: 0,
      readinessTimeoutMs: options.readinessTimeoutMs ?? 50,
      schedule: async (variables) => {
        scheduled.push(variables);
      },
      scheduledAt: null,
      sharedContent: "Caption",
      signal: controller.signal,
      sourcePostId: null,
      sourceProfileId: "profile-a",
      targetsByProfile: new Map([
        ["profile-a", [{ attachment_ids: null, overrides: {}, platform_account_id: "channel-a" }]],
      ]),
      update: async (variables) => {
        updated.push(variables);
        return saved;
      },
      workspaceId: null,
    });

  return { copies, created, progress, run, scheduled, updated };
}

describe("persistProfileCopies", () => {
  it("saves a draft without reading assets or scheduling", async () => {
    const reads: string[] = [];
    const { copies, created, progress, run, scheduled } = setup({
      mode: "draft",
      readAsset: (_workspaceId, assetId) => {
        reads.push(assetId);
        return Effect.succeed({ status: "ready" } as Asset);
      },
    });

    expect(await run()).toEqual(true);
    expect(created).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(copies.get("profile-a")?.postId).toEqual("post-a");
    expect(progress.map((event) => event.phase)).toEqual(["media", "saving", "saved"]);
  });

  it("polls processing media until ready and schedules once", async () => {
    const states: Asset["status"][] = ["processing", "ready"];
    const { created, progress, run, scheduled } = setup({
      readAsset: () => Effect.succeed({ status: states.shift() ?? "ready" } as Asset),
    });

    expect(await run()).toEqual(true);
    expect(created).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(progress.map((event) => event.phase)).toEqual([
      "media",
      "saving",
      "saved",
      "media",
      "scheduling",
      "scheduled",
    ]);
  });

  it("fails on a stalled readiness read and retries the retained Post once ready", async () => {
    let processing = true;
    const { copies, created, progress, run, scheduled, updated } = setup({
      readAsset: () => (processing ? Effect.never : Effect.succeed({ status: "ready" } as Asset)),
      readinessTimeoutMs: 1,
    });

    expect(await run()).toEqual(false);
    expect(progress.at(-1)?.phase).toEqual("failed");
    expect(copies.get("profile-a")?.postId).toEqual("post-a");
    expect(scheduled).toEqual([]);

    processing = false;
    expect(await run()).toEqual(true);
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(progress.at(-1)).toEqual({ phase: "scheduled", profileId: "profile-a" });
  });

  it("skips rescheduling when the intent fingerprint is unchanged", async () => {
    const { created, run, scheduled } = setup();

    expect(await run()).toEqual(true);
    expect(await run()).toEqual(true);
    expect(created).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it("fails without scheduling when an asset finishes in a failed state", async () => {
    const { progress, run, scheduled } = setup({
      readAsset: () =>
        Effect.succeed({
          failure: { message: "Transcode failed" },
          status: "failed",
        } as Asset),
    });

    expect(await run()).toEqual(false);
    expect(scheduled).toEqual([]);
    expect(progress.at(-1)).toEqual({
      error: new Error("Transcode failed"),
      phase: "failed",
      profileId: "profile-a",
    });
  });
});
