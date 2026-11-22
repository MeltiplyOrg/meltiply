import { Effect } from "effect";
import { mediaUploadExtension } from "@meltiply/domain";
import { getAsset, getAssetBlob } from "@/lib/api";
import { runQueryEffect } from "@/lib/effect";
import { createAssetUpload } from "@/lib/upload";
import type { Asset, CreatePostInput, Post, SchedulePostInput, UpdatePostInput } from "@/types";
import type { PostTargetDraft } from "./platform-settings";

export interface ProfileCopy {
  postId?: string;
  updatedAt?: string;
  assets: Map<string, string>;
  scheduledIntent?: string;
}

export interface CopyAttachment {
  assetId: string;
  name: string;
  mimeType: string | null;
  file?: File;
}

export interface ProfileCopyProgress {
  profileId: string;
  phase: "media" | "saving" | "saved" | "scheduling" | "scheduled" | "failed";
  error?: unknown;
}

export async function persistProfileCopies({
  profileIds,
  sourceProfileId,
  sourcePostId,
  attachments,
  sharedContent,
  targetsByProfile,
  publicationTargetsByProfile,
  scheduledAt,
  mode,
  workspaceId,
  copies,
  signal,
  create,
  update,
  schedule,
  onProgress,
}: {
  profileIds: readonly string[];
  sourceProfileId: string;
  sourcePostId: string | null;
  attachments: readonly CopyAttachment[];
  sharedContent: string;
  targetsByProfile: ReadonlyMap<string, readonly PostTargetDraft[]>;
  publicationTargetsByProfile: ReadonlyMap<string, readonly PostTargetDraft[]>;
  scheduledAt: string | null;
  mode: "draft" | "schedule" | "now";
  workspaceId: string | null;
  copies: Map<string, ProfileCopy>;
  signal: AbortSignal;
  create: (input: CreatePostInput) => Promise<Post>;
  update: (variables: { id: string; input: UpdatePostInput }) => Promise<Post>;
  schedule: (variables: { id: string; input: SchedulePostInput }) => Promise<unknown>;
  onProgress: (progress: ProfileCopyProgress) => void;
}): Promise<boolean> {
  let saveFailed = false;
  const intents = new Map<
    string,
    {
      input: SchedulePostInput;
      fingerprint: string;
      assetIds: Set<string>;
    }
  >();
  for (const profileId of profileIds) {
    signal.throwIfAborted();
    let copy = copies.get(profileId);
    if (!copy) {
      copy = { assets: new Map() };
      copies.set(profileId, copy);
    }
    try {
      onProgress({ profileId, phase: "media" });
      for (const attachment of attachments) {
        signal.throwIfAborted();
        if (copy.assets.has(attachment.assetId)) continue;
        if (profileId === sourceProfileId) {
          copy.assets.set(attachment.assetId, attachment.assetId);
          continue;
        }
        let file = attachment.file;
        if (!file) {
          const blob = await runQueryEffect(getAssetBlob(workspaceId, attachment.assetId), {
            signal,
          });
          const mimeType = attachment.mimeType ?? blob.type;
          const extension = mediaUploadExtension(mimeType);
          if (!extension) throw new Error("The original media has an unsupported content type.");
          file = new File([blob], `${attachment.name}.${extension}`, { type: mimeType });
        }
        const task = createAssetUpload({ workspaceId, brandProfileId: profileId, file });
        const cancel = () => {
          void task.cancel();
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          const asset = await task.result;
          copy.assets.set(attachment.assetId, asset.id);
        } catch (error) {
          await task.cancel();
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }
      const remap = (id: string): string => {
        const mapped = copy.assets.get(id);
        if (!mapped) throw new Error("An attachment copy is missing.");
        return mapped;
      };
      const targets = (targetsByProfile.get(profileId) ?? []).map((target) => ({
        ...target,
        ...(target.attachment_ids ? { attachment_ids: target.attachment_ids.map(remap) } : {}),
      }));
      const attachmentIds = attachments.map((attachment) => remap(attachment.assetId));
      const profileInput = {
        default_text: sharedContent,
        brand_profile_id: profileId,
        attachment_ids: attachmentIds,
        targets,
      };
      if (mode !== "draft") {
        const publicationTargets = (publicationTargetsByProfile.get(profileId) ?? []).map(
          (target) => ({
            ...target,
            ...(target.attachment_ids ? { attachment_ids: target.attachment_ids.map(remap) } : {}),
          }),
        );
        const fingerprint = JSON.stringify({
          mode,
          ...profileInput,
          publicationTargets,
          scheduledAt,
        });
        if (copy.postId && copy.scheduledIntent === fingerprint) {
          onProgress({ profileId, phase: "scheduled" });
          continue;
        }
        const assetIds = new Set<string>();
        for (const target of publicationTargets)
          for (const id of target.attachment_ids ?? attachmentIds) assetIds.add(id);
        intents.set(profileId, {
          input: {
            brand_profile_id: profileId,
            scheduled_at: scheduledAt,
            targets: publicationTargets,
          },
          fingerprint,
          assetIds,
        });
      }
      onProgress({ profileId, phase: "saving" });
      const id = copy.postId ?? (profileId === sourceProfileId ? sourcePostId : null);
      const saved = id ? await update({ id, input: profileInput }) : await create(profileInput);
      copy.postId = saved.id;
      copy.updatedAt = saved.updated_at;
      delete copy.scheduledIntent;
      onProgress({ profileId, phase: "saved" });
    } catch (error) {
      signal.throwIfAborted();
      saveFailed = true;
      onProgress({ profileId, phase: "failed", error });
    }
  }
  if (saveFailed || mode === "draft") return !saveFailed;
  let scheduleFailed = false;
  for (const [profileId, intent] of intents) {
    try {
      signal.throwIfAborted();
      const copy = copies.get(profileId);
      if (!copy?.postId) throw new Error("The saved profile copy is missing.");
      onProgress({ profileId, phase: "media" });
      const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
      for (const assetId of intent.assetIds) {
        let asset: Asset = await runQueryEffect(getAsset(workspaceId, assetId), {
          signal: readinessSignal,
        });
        while (
          asset.status === "pending_upload" ||
          asset.status === "uploading" ||
          asset.status === "processing"
        ) {
          await runQueryEffect(Effect.sleep("1 second"), { signal: readinessSignal });
          asset = await runQueryEffect(getAsset(workspaceId, assetId), { signal: readinessSignal });
        }
        if (asset.status !== "ready")
          throw new Error(asset.failure?.message ?? "An attachment could not finish processing.");
      }
      onProgress({ profileId, phase: "scheduling" });
      await schedule({ id: copy.postId, input: intent.input });
      copy.scheduledIntent = intent.fingerprint;
      onProgress({ profileId, phase: "scheduled" });
    } catch (error) {
      signal.throwIfAborted();
      scheduleFailed = true;
      onProgress({ profileId, phase: "failed", error });
    }
  }
  return !scheduleFailed;
}
