import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import {
  codePointLength,
  isAccountUsable,
  isoDateTime,
  type DatabaseError,
} from "@meltiply/domain";
import {
  composeCaption,
  hasProviderHostedContent,
  ProviderRegistry,
  resolvePublishProviderOptions,
  toWirePostProviderOptions,
  validatePublishInput,
  type ProviderMedia,
  type ProviderPublishOptions,
} from "@meltiply/providers";

import { CoreApiError, toCoreApiErrorOrRethrow } from "./api-errors";
import { assetSelectColumns, mapAsset, type AssetRow } from "./asset-types";
import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import { withTenantTransactionEffect, type EffectTransactionClient } from "./database";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { withTenantIdempotentMutation } from "./idempotent-mutation";
import { lockOrganizationEffect } from "./organization-lock";
import {
  deletePendingDistributionOutboxEffect,
  distributionColumns,
  insertOutboxBatchEffect,
  isPendingDistribution,
  mapDistribution,
  providerOwnedDistributionSql,
  providerReachedDistributionStatuses,
  publicationSnapshotColumn,
  usageGuardEffect,
  validateTargetOverrides,
} from "./distribution-service";
import type {
  CreatePostInput,
  DeletePostInput,
  PostApiService,
  PostFilters,
  PostProviderOptions,
  PostServiceError,
  PostTargetInput,
  SchedulePostInput,
  UpdatePostInput,
} from "./post-types";
import { releaseQueueMembershipEffect, reserveQueueSlotEffect } from "./publishing-queue-store";

type Schemas = components["schemas"];
type Platform = Schemas["Platform"];
type PlatformCapability = Schemas["PlatformCapability"];
type Post = Schemas["Post"];
type PostStatus = Schemas["PostStatus"];

const postQueueMembershipColumn = `(
  SELECT jsonb_build_object('queue_id', membership.queue_id,
           'queue_name', membership.queue_name, 'assigned_at', membership.assigned_at)
  FROM publishing_queue_memberships membership
  WHERE membership.post_id = posts.id AND membership.released_at IS NULL
) AS queue_membership`;
const postColumns = `
  id, org_id, brand_profile_id, title, default_text, status, revision,
  created_at, updated_at, ${postQueueMembershipColumn}`;

const assetColumns = assetSelectColumns("asset");

interface PostRow extends Record<string, unknown> {
  brand_profile_id: string;
  created_at: Date | string;
  default_text: string;
  id: string;
  org_id: string;
  revision: number | string;
  queue_membership: Schemas["QueueMembership"] | null;
  status: PostStatus;
  title: string;
  updated_at: Date | string;
}

type PostMutationRow = Pick<
  PostRow,
  "id" | "org_id" | "brand_profile_id" | "title" | "default_text" | "queue_membership"
>;

interface TargetRow extends Record<string, unknown> {
  attachment_ids: string[] | null;
  description_override: string | null;
  hashtags: string[] | null;
  platform_account_id: string;
  post_id?: string;
  provider_options: PostProviderOptions | null;
  signature_text: string | null;
  title_override: string | null;
}

interface AccountRow extends Record<string, unknown> {
  account_brand_profile_id: string | null;
  connection_status: string | null;
  id: string;
  platform: Platform | null;
  revoked_at: Date | string | null;
  token_expires_at: Date | string | null;
}

interface AttachmentRow extends Record<string, unknown> {
  asset_id: string;
  position: number | string;
  post_id: string;
}

interface CandidateRow extends Record<string, unknown> {
  asset_id: string;
  bytes: number | string;
  content_type: string;
  duration_sec: number | string | null;
  height: number | string | null;
  width: number | string | null;
}

interface DistributionSummaryRow extends Record<string, unknown> {
  id: string;
  platform_account_id: string | null;
  provider_owned: boolean;
  status: Schemas["DistributionStatus"];
}

interface ResolvedTargetRow {
  platform: Platform;
  platformAccountId: string;
  target: Omit<PostTargetInput, "providerOptions"> & { providerOptions?: ProviderPublishOptions };
}

interface PendingTargetRow extends ResolvedTargetRow {
  distributionId: string;
}

interface PostCollections {
  analytics: Map<string, Schemas["PostAnalytics"]>;
  analyticsByDistribution: Map<string, Schemas["PostDistributionAnalytics"][]>;
  attachments: Map<string, Schemas["PostAttachment"][]>;
  distributions: Map<string, Schemas["Distribution"][]>;
  targets: Map<string, Schemas["PostTarget"][]>;
}

interface PostAnalyticsRow extends Record<string, unknown> {
  post_id: string;
  distribution_id: string;
  platform: Platform;
  likes: number | string;
  comments: number | string;
  shares: number | string;
  views: number | string;
  impressions: number | string;
  reach: number | string;
}

function mapTarget(row: TargetRow): Schemas["PostTarget"] {
  return {
    attachment_ids: row.attachment_ids ?? null,
    description_override: row.description_override,
    hashtags: row.hashtags ?? [],
    platform_account_id: row.platform_account_id,
    provider_options: toWirePostProviderOptions(row.provider_options),
    signature: row.signature_text,
    title_override: row.title_override,
  };
}

interface PostCollectionPreloads {
  attachments?: Map<string, Schemas["PostAttachment"][]>;
  distributions?: Map<string, Schemas["Distribution"][]>;
  targets?: Map<string, Schemas["PostTarget"][]>;
}

function loadPostCollectionsEffect(
  client: EffectTransactionClient,
  postIds: readonly string[],
  preloads: PostCollectionPreloads = {},
): Effect.Effect<PostCollections, PostServiceError> {
  return Effect.gen(function* () {
    const collections: PostCollections = {
      analytics: new Map(),
      analyticsByDistribution: new Map(),
      attachments: preloads.attachments ?? new Map(),
      distributions: preloads.distributions ?? new Map(),
      targets: preloads.targets ?? new Map(),
    };
    if (postIds.length === 0) return collections;
    if (!preloads.attachments) {
      const attachmentRows = yield* client.query<AttachmentRow & AssetRow>(
        `SELECT pa.post_id, pa.asset_id, pa.position, ${assetColumns}
           FROM post_attachments AS pa
           JOIN assets AS asset ON asset.id = pa.asset_id AND asset.org_id = pa.org_id
          WHERE pa.post_id = ANY($1::uuid[])
          ORDER BY pa.post_id, pa.position`,
        [postIds],
      );
      for (const row of attachmentRows.rows) {
        const bucket = collections.attachments.get(row.post_id) ?? [];
        bucket.push({
          asset: mapAsset(row),
          asset_id: row.asset_id,
          position: Number(row.position),
        });
        collections.attachments.set(row.post_id, bucket);
      }
    }
    if (!preloads.targets) {
      const targetRows = yield* client.query<TargetRow>(
        `SELECT post_id, platform_account_id, title_override,
                description_override, hashtags, provider_options, signature_text, attachment_ids
           FROM post_targets
          WHERE post_id = ANY($1::uuid[])
          ORDER BY post_id, created_at, platform_account_id`,
        [postIds],
      );
      for (const row of targetRows.rows) {
        const postId = row.post_id!;
        const bucket = collections.targets.get(postId) ?? [];
        bucket.push(mapTarget(row));
        collections.targets.set(postId, bucket);
      }
    }
    if (!preloads.distributions) {
      const distributionRows = yield* client.query<Parameters<typeof mapDistribution>[0]>(
        `SELECT ${distributionColumns},
                ${publicationSnapshotColumn}
           FROM distributions
          WHERE post_id = ANY($1::uuid[])
          ORDER BY post_id, event_at DESC, id DESC`,
        [postIds],
      );
      for (const row of distributionRows.rows) {
        const bucket = collections.distributions.get(row.post_id) ?? [];
        bucket.push(mapDistribution(row));
        collections.distributions.set(row.post_id, bucket);
      }
    }
    let hasPublishedDistribution = false;
    for (const distributions of collections.distributions.values()) {
      if (distributions.some((row) => row.status === "published")) {
        hasPublishedDistribution = true;
        break;
      }
    }
    if (hasPublishedDistribution) {
      const analyticsRows = yield* client.query<PostAnalyticsRow>(
        `SELECT d.post_id, d.id AS distribution_id, d.platform,
                snapshot.likes, snapshot.comments, snapshot.shares,
                snapshot.views, snapshot.impressions, snapshot.reach
           FROM distributions d
           JOIN LATERAL (
             SELECT likes, comments, shares, views, impressions, reach
               FROM analytics_snapshots
              WHERE distribution_id = d.id
              ORDER BY snapshot_at DESC, id DESC
              LIMIT 1
           ) snapshot ON true
          WHERE d.post_id = ANY($1::uuid[]) AND d.status = 'published'
          ORDER BY d.post_id, d.platform, d.id`,
        [postIds],
      );
      for (const row of analyticsRows.rows) {
        const analytics: Schemas["PostAnalytics"] = {
          likes: Number(row.likes),
          comments: Number(row.comments),
          shares: Number(row.shares),
          saves: null,
          clicks: null,
          views: Number(row.views),
          impressions: Number(row.impressions),
          reach: Number(row.reach),
        };
        const channelRows = collections.analyticsByDistribution.get(row.post_id) ?? [];
        channelRows.push({
          analytics,
          distribution_id: row.distribution_id,
          platform: row.platform,
        });
        collections.analyticsByDistribution.set(row.post_id, channelRows);

        const totals = collections.analytics.get(row.post_id);
        collections.analytics.set(row.post_id, {
          likes: (totals?.likes ?? 0) + (analytics.likes ?? 0),
          comments: (totals?.comments ?? 0) + (analytics.comments ?? 0),
          shares: (totals?.shares ?? 0) + (analytics.shares ?? 0),
          saves: null,
          clicks: null,
          views: (totals?.views ?? 0) + (analytics.views ?? 0),
          impressions: (totals?.impressions ?? 0) + (analytics.impressions ?? 0),
          reach: (totals?.reach ?? 0) + (analytics.reach ?? 0),
        });
      }
    }
    return collections;
  });
}

function assemblePost(row: PostRow, collections: PostCollections): Post {
  return {
    analytics: collections.analytics.get(row.id) ?? null,
    distribution_analytics: collections.analyticsByDistribution.get(row.id) ?? [],
    attachments: collections.attachments.get(row.id) ?? [],
    brand_profile_id: row.brand_profile_id,
    created_at: isoDateTime(row.created_at),
    default_text: row.default_text,
    distributions: collections.distributions.get(row.id) ?? [],
    id: row.id,
    org_id: row.org_id,
    queue_membership:
      row.queue_membership === null
        ? null
        : {
            ...row.queue_membership,
            assigned_at: new Date(row.queue_membership.assigned_at).toISOString(),
          },
    revision: Number(row.revision),
    status: row.status,
    targets: collections.targets.get(row.id) ?? [],
    title: row.title,
    updated_at: isoDateTime(row.updated_at),
  };
}

export function assemblePostsEffect(
  client: EffectTransactionClient,
  rows: readonly PostRow[],
  preloads: PostCollectionPreloads = {},
): Effect.Effect<Post[], PostServiceError> {
  return loadPostCollectionsEffect(
    client,
    rows.map((row) => row.id),
    preloads,
  ).pipe(Effect.map((collections) => rows.map((row) => assemblePost(row, collections))));
}

export function assembleSinglePostEffect(
  client: EffectTransactionClient,
  row: PostRow,
  preloads: PostCollectionPreloads = {},
): Effect.Effect<Post, PostServiceError> {
  return loadPostCollectionsEffect(client, [row.id], preloads).pipe(
    Effect.map((collections) => assemblePost(row, collections)),
  );
}

export function lockPostEffect(
  client: EffectTransactionClient,
  postId: string,
  readModel: true,
): Effect.Effect<PostRow, CoreApiError | DatabaseError>;
export function lockPostEffect(
  client: EffectTransactionClient,
  postId: string,
  readModel?: false,
): Effect.Effect<PostMutationRow, CoreApiError | DatabaseError>;
export function lockPostEffect(
  client: EffectTransactionClient,
  postId: string,
  readModel = false,
): Effect.Effect<PostMutationRow, CoreApiError | DatabaseError> {
  const selectSql = readModel
    ? `SELECT ${postColumns}
         FROM posts
        WHERE id = $1 AND org_id = public.auth_active_org_id() AND deleted_at IS NULL
        FOR UPDATE`
    : `SELECT id, org_id, brand_profile_id, title, default_text, ${postQueueMembershipColumn}
         FROM posts
        WHERE id = $1 AND org_id = public.auth_active_org_id() AND deleted_at IS NULL
        FOR UPDATE`;
  return Effect.gen(function* () {
    const result = yield* client.query<PostMutationRow>(selectSql, [postId]);
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(new CoreApiError(404, "post_not_found", "The post was not found."));
    }
    return row;
  });
}

function lockPostAttachmentAssetsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `SELECT asset.id
         FROM assets AS asset
         JOIN post_attachments AS attachment ON attachment.asset_id = asset.id
        WHERE attachment.post_id = $1
        ORDER BY asset.id
        FOR UPDATE OF asset`,
      [postId],
    )
    .pipe(Effect.asVoid);
}

function requireMatchingBrandProfile(
  post: Pick<PostRow, "brand_profile_id">,
  brandProfileId: string,
): void {
  if (post.brand_profile_id !== brandProfileId) {
    throw new CoreApiError(
      422,
      "brand_profile_mismatch",
      "The post belongs to a different brand profile.",
    );
  }
}

function lockAttachmentAssetsEffect(
  client: EffectTransactionClient,
  brandProfileId: string,
  attachmentIds: readonly string[],
  alsoLockIds: readonly string[] = [],
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      return yield* Effect.fail(
        new CoreApiError(422, "validation_error", "attachment_ids must not repeat an asset."),
      );
    }
    const lockIds = [...new Set([...alsoLockIds, ...attachmentIds])].sort();
    if (lockIds.length === 0) return;
    const locked = yield* client.query<{
      id: string;
      brand_profile_id: string;
      status: AssetRow["status"];
      has_live_session: boolean;
    }>(
      `SELECT asset.id, asset.brand_profile_id, asset.status,
              EXISTS (
                SELECT 1
                  FROM asset_upload_sessions AS upload_session
                 WHERE upload_session.asset_id = asset.id
                   AND upload_session.status IN ('created', 'uploading', 'completing')
                   AND upload_session.expires_at > now()
              ) AS has_live_session
         FROM assets AS asset
        WHERE asset.id = ANY($1::uuid[])
          AND asset.org_id = public.auth_active_org_id()
        ORDER BY asset.id
        FOR UPDATE`,
      [lockIds],
    );
    if (locked.rows.length !== lockIds.length) {
      return yield* Effect.fail(
        new CoreApiError(404, "asset_not_found", "One of the attachments was not found."),
      );
    }
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    for (const assetId of attachmentIds) {
      const asset = byId.get(assetId)!;
      if (asset.brand_profile_id !== brandProfileId) {
        return yield* Effect.fail(
          new CoreApiError(
            422,
            "brand_profile_mismatch",
            "An attachment belongs to a different brand profile.",
          ),
        );
      }
      if (asset.status === "deleting" || asset.status === "deleted") {
        return yield* Effect.fail(
          new CoreApiError(
            409,
            "asset_not_attachable",
            "Media that is being deleted cannot be attached.",
          ),
        );
      }
      if (
        (asset.status === "pending_upload" || asset.status === "uploading") &&
        asset.has_live_session !== true
      ) {
        return yield* Effect.fail(
          new CoreApiError(
            409,
            "asset_not_attachable",
            "The upload for that attachment is no longer active.",
          ),
        );
      }
    }
  });
}

function replaceAttachmentsEffect(
  client: EffectTransactionClient,
  post: PostMutationRow,
  assetIds: readonly string[],
  previousIds: readonly string[],
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    if (
      previousIds.length === assetIds.length &&
      previousIds.every((id, index) => id === assetIds[index])
    ) {
      return;
    }
    yield* client.query("DELETE FROM post_attachments WHERE post_id = $1", [post.id]);
    if (assetIds.length === 0) return;
    yield* client.query(
      `INSERT INTO post_attachments
         (post_id, asset_id, org_id, brand_profile_id, position)
       SELECT $1::uuid, selected.asset_id, $3::uuid, $4::uuid,
              selected.ordinality - 1
         FROM unnest($2::uuid[]) WITH ORDINALITY
           AS selected(asset_id, ordinality)`,
      [post.id, assetIds, post.org_id, post.brand_profile_id],
    );
  });
}

function replaceTargetsEffect(
  client: EffectTransactionClient,
  post: PostMutationRow,
  targets: readonly PostTargetInput[],
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    if (new Set(targets.map((target) => target.platformAccountId)).size !== targets.length) {
      return yield* Effect.fail(
        new CoreApiError(422, "validation_error", "targets must contain unique platform accounts."),
      );
    }
    yield* client.query("DELETE FROM post_targets WHERE post_id = $1", [post.id]);
    if (targets.length === 0) return;
    yield* client.query(
      `INSERT INTO post_targets
         (post_id, platform_account_id, org_id, brand_profile_id,
          title_override, description_override, hashtags, provider_options,
          signature_text, attachment_ids)
       SELECT $1::uuid, selected.platform_account_id, $3::uuid, $4::uuid,
              selected.title_override, selected.description_override,
              selected.hashtags, selected.provider_options,
              selected.signature_text, selected.attachment_ids
         FROM jsonb_to_recordset($2::jsonb) AS selected(
           platform_account_id uuid,
           title_override text,
           description_override text,
           hashtags text[],
           provider_options jsonb,
           signature_text text,
           attachment_ids uuid[]
         )`,
      [
        post.id,
        JSON.stringify(
          targets.map((target) => ({
            attachment_ids: target.attachmentIds ?? null,
            description_override: target.descriptionOverride ?? null,
            hashtags: target.hashtags ?? [],
            platform_account_id: target.platformAccountId,
            provider_options: target.providerOptions ?? {},
            signature_text: target.signature ?? null,
            title_override: target.titleOverride ?? null,
          })),
        ),
        post.org_id,
        post.brand_profile_id,
      ],
    );
  });
}

function loadSavedTargetsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<{ inputs: PostTargetInput[]; rows: TargetRow[] }, DatabaseError> {
  return client
    .query<TargetRow>(
      `SELECT platform_account_id, title_override, description_override,
              hashtags, provider_options, signature_text, attachment_ids
         FROM post_targets
        WHERE post_id = $1
        ORDER BY created_at, platform_account_id`,
      [postId],
    )
    .pipe(
      Effect.map((result) => ({
        inputs: result.rows.map((row) => ({
          attachmentIds: row.attachment_ids,
          descriptionOverride: row.description_override,
          hashtags: row.hashtags ?? [],
          platformAccountId: row.platform_account_id,
          providerOptions: row.provider_options ?? undefined,
          signature: row.signature_text,
          titleOverride: row.title_override,
        })),
        rows: result.rows,
      })),
    );
}

function requireTargetAttachmentScope(
  targets: readonly PostTargetInput[],
  attachmentIds: readonly string[],
): void {
  const owned = new Set(attachmentIds);
  for (const target of targets) {
    if (!target.attachmentIds) continue;
    const foreign = target.attachmentIds.filter((id) => !owned.has(id));
    if (foreign.length > 0) {
      throw new CoreApiError(
        422,
        "validation_error",
        "A target can only select attachments of its own post.",
      );
    }
  }
}

function validateTargetScopesEffect(
  client: EffectTransactionClient,
  organizationId: string,
  brandProfileId: string,
  targets: readonly PostTargetInput[],
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    if (targets.length === 0) return;
    if (new Set(targets.map((target) => target.platformAccountId)).size !== targets.length) {
      return yield* Effect.fail(
        new CoreApiError(422, "validation_error", "targets must contain unique platform accounts."),
      );
    }
    const accounts = yield* loadAccountsEffect(
      client,
      organizationId,
      targets.map((target) => target.platformAccountId),
    );
    for (const target of targets) {
      const account = accounts.get(target.platformAccountId);
      if (!account) {
        return yield* Effect.fail(
          new CoreApiError(
            404,
            "platform_account_not_found",
            "The platform account was not found.",
          ),
        );
      }
      if (account.account_brand_profile_id !== brandProfileId) {
        return yield* Effect.fail(
          new CoreApiError(
            422,
            "brand_profile_mismatch",
            "A platform account belongs to a different brand profile.",
          ),
        );
      }
    }
  });
}

function loadAccountsEffect(
  client: EffectTransactionClient,
  organizationId: string,
  accountIds: readonly string[],
): Effect.Effect<Map<string, AccountRow>, DatabaseError> {
  return client
    .query<AccountRow>(
      `SELECT account.id,
              account.brand_profile_id AS account_brand_profile_id,
              account.platform,
              account.connection_status,
              account.revoked_at,
              account.token_expires_at
         FROM platform_accounts AS account
         JOIN organizations AS organization
           ON organization.id = account.org_id
        WHERE account.id = ANY($1::uuid[])
          AND account.org_id = $2`,
      [accountIds, organizationId],
    )
    .pipe(Effect.map((result) => new Map(result.rows.map((row) => [row.id, row]))));
}

function loadRenditionCandidatesEffect(
  client: EffectTransactionClient,
  assetIds: readonly string[],
): Effect.Effect<Map<string, CandidateRow[]>, DatabaseError> {
  return Effect.gen(function* () {
    if (assetIds.length === 0) return new Map<string, CandidateRow[]>();
    const result = yield* client.query<CandidateRow>(
      `SELECT DISTINCT rendition.asset_id, object.r2_key AS object_key,
              object.bytes, object.content_type, object.duration_sec,
              object.width, object.height
         FROM asset_renditions AS rendition
         JOIN asset_objects AS object
           ON object.id = rendition.object_id
          AND object.asset_id = rendition.asset_id
          AND object.org_id = rendition.org_id
          AND object.brand_profile_id = rendition.brand_profile_id
         JOIN assets AS asset
           ON asset.id = rendition.asset_id
          AND asset.org_id = rendition.org_id
          AND asset.brand_profile_id = rendition.brand_profile_id
        WHERE rendition.asset_id = ANY($1::uuid[])
          AND rendition.status = 'ready'
          AND object.status = 'ready'
          AND object.kind IN ('original', 'rendition')
          AND object.bytes IS NOT NULL
          AND object.content_type IS NOT NULL
          AND asset.status = 'ready'
          AND asset.deleted_at IS NULL
        ORDER BY rendition.asset_id, object.bytes, object_key`,
      [assetIds],
    );
    const grouped = new Map<string, CandidateRow[]>();
    for (const row of result.rows) {
      const bucket = grouped.get(row.asset_id) ?? [];
      bucket.push(row);
      grouped.set(row.asset_id, bucket);
    }
    return grouped;
  });
}

function resolveTargetProviderOptions(
  options: PostProviderOptions | undefined,
  platform: Platform,
  selection: readonly string[],
  candidates: ReadonlyMap<string, CandidateRow[]>,
): ProviderPublishOptions | undefined {
  const kinds = selection.map((assetId) => {
    const candidate = (candidates.get(assetId) ?? [])[0];
    return candidate?.content_type.startsWith("video/")
      ? ("video" as const)
      : candidate?.content_type.startsWith("image/")
        ? ("image" as const)
        : null;
  });
  const resolved = resolvePublishProviderOptions(options, platform, kinds);
  if (!resolved.ok) {
    throw new CoreApiError(422, "validation_error", resolved.message);
  }
  return resolved.value;
}

function validateTargetScheduleEffect(
  post: PostMutationRow,
  target: PostTargetInput,
  selection: readonly string[],
  account: AccountRow | undefined,
  capability: PlatformCapability | undefined,
  candidates: ReadonlyMap<string, CandidateRow[]>,
  now: Date,
): Effect.Effect<ResolvedTargetRow, CoreApiError> {
  return Effect.suspend(() => {
    if (!account?.platform) {
      return Effect.fail(
        new CoreApiError(404, "platform_account_not_found", "The platform account was not found."),
      );
    }
    const platform = account.platform;
    if (account.account_brand_profile_id !== post.brand_profile_id) {
      return Effect.fail(
        new CoreApiError(
          422,
          "brand_profile_mismatch",
          "The platform account belongs to a different brand profile.",
        ),
      );
    }
    if (!isAccountUsable(account, now.getTime())) {
      return Effect.fail(
        new CoreApiError(
          409,
          "platform_reconnect_required",
          "Reconnect the platform account before publishing.",
        ),
      );
    }
    if (!capability?.publish) {
      return Effect.fail(
        new CoreApiError(422, "unsupported_capability", `${platform} does not support publishing.`),
      );
    }
    let providerOptions: ProviderPublishOptions | undefined;
    try {
      validateTargetOverrides(target);
      providerOptions = resolveTargetProviderOptions(
        target.providerOptions,
        platform,
        selection,
        candidates,
      );
    } catch (cause) {
      return cause instanceof CoreApiError ? Effect.fail(cause) : Effect.die(cause);
    }
    const media: ProviderMedia[] = [];
    for (const assetId of selection) {
      const available = candidates.get(assetId) ?? [];
      const candidate =
        available.find((row) => capability.accepted_mime_types.includes(row.content_type)) ??
        available[0];
      if (!candidate) {
        return Effect.fail(
          new CoreApiError(
            409,
            "asset_not_ready",
            "One of the attachments has no verified media ready to publish.",
          ),
        );
      }
      media.push({
        contentType: candidate.content_type,
        fileSize: Number(candidate.bytes),
        metadata: {
          ...(candidate.duration_sec !== null
            ? { durationSeconds: Number(candidate.duration_sec) }
            : {}),
          ...(candidate.height !== null ? { height: Number(candidate.height) } : {}),
          ...(candidate.width !== null ? { width: Number(candidate.width) } : {}),
        },
        mode: "remote_ingest",
        url: "https://validation.invalid/media",
      });
    }
    const issues = validatePublishInput(capability, {
      caption: composeCaption({
        defaultText: post.default_text,
        descriptionOverride: target.descriptionOverride ?? null,
        hashtags: target.hashtags ?? [],
        signature: target.signature ?? null,
        title: post.title,
        titleOverride: target.titleOverride ?? null,
      }),
      hashtags: target.hashtags ?? [],
      idempotencyKey: "",
      media,
      ...(providerOptions ? { providerOptions } : {}),
    });
    if (issues.length > 0) {
      return Effect.fail(
        new CoreApiError(
          422,
          "validation_error",
          "The post does not satisfy the platform publishing limits for this target.",
          undefined,
          issues.map((issue) => ({
            actual: issue.actual,
            code: issue.constraint,
            constraint: issue.constraint,
            field: issue.field,
            limit: issue.limit,
            message: issue.message,
          })),
        ),
      );
    }
    return Effect.succeed({
      platform,
      platformAccountId: target.platformAccountId,
      target: { ...target, providerOptions },
    });
  });
}

function validatePostText(title: string, defaultText: string): void {
  if (title.length > 200) {
    throw new CoreApiError(422, "validation_error", "title is too long.");
  }
  if (codePointLength(defaultText) > 10_000) {
    throw new CoreApiError(422, "validation_error", "default_text is too long.");
  }
}

function validateCompositionEffect(
  title: string,
  defaultText: string,
  attachmentIds: readonly string[],
  effectiveTargets: readonly PostTargetInput[],
  changedTargets: readonly PostTargetInput[] = effectiveTargets,
): Effect.Effect<void, CoreApiError> {
  return Effect.try({
    try: () => {
      validatePostText(title, defaultText);
      requireNonEmptyPost(defaultText, attachmentIds, effectiveTargets);
      requireTargetAttachmentScope(changedTargets, attachmentIds);
    },
    catch: toCoreApiErrorOrRethrow,
  });
}

function requireNonEmptyPost(
  defaultText: string,
  attachmentIds: readonly string[],
  targets: readonly PostTargetInput[],
): void {
  if (defaultText.trim() || attachmentIds.length) return;
  if (
    targets.some(
      ({ descriptionOverride, providerOptions: options }) =>
        descriptionOverride?.trim() || hasProviderHostedContent(options),
    )
  )
    return;
  throw new CoreApiError(
    422,
    "validation_error",
    "A Post requires text, an attachment, or provider-hosted content.",
  );
}

function updatePostRowEffect(
  client: EffectTransactionClient,
  postId: string,
  patch: {
    activate?: boolean;
    defaultText?: string;
    title?: string;
  },
): Effect.Effect<PostRow, DatabaseError> {
  return client
    .query<PostRow>(
      `UPDATE posts SET
         title = CASE WHEN $2::boolean THEN $3 ELSE title END,
         default_text = CASE WHEN $4::boolean THEN $5 ELSE default_text END,
         status = CASE WHEN $6::boolean THEN 'active' ELSE status END,
         revision = revision + 1,
         updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${postColumns}`,
      [
        postId,
        patch.title !== undefined,
        patch.title ?? null,
        patch.defaultText !== undefined,
        patch.defaultText ?? null,
        patch.activate === true,
      ],
    )
    .pipe(Effect.map((result) => result.rows[0]!));
}

function loadPostAttachmentIdsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<string[], DatabaseError> {
  return client
    .query<{
      asset_id: string;
    }>(`SELECT asset_id FROM post_attachments WHERE post_id = $1 ORDER BY position`, [postId])
    .pipe(Effect.map((result) => result.rows.map((row) => row.asset_id)));
}

function reschedulePendingDistributionsEffect(
  client: EffectTransactionClient,
  postId: string,
  rows: readonly PendingTargetRow[],
  status: Schemas["DistributionStatus"],
  scheduledAt: string | null,
): Effect.Effect<string[], DatabaseError> {
  if (rows.length === 0) return Effect.succeed([]);
  return client
    .query<{ id: string }>(
      `UPDATE distributions AS distribution
          SET status = $3::text,
              scheduled_at = $4::timestamptz,
              title_override = target.title_override,
              description_override = target.description_override,
              hashtags = target.hashtags,
              provider_options = target.provider_options,
              signature_text = target.signature_text,
              attachment_ids = target.attachment_ids,
              updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS target(
                distribution_id uuid,
                platform_account_id uuid,
                title_override text,
                description_override text,
                hashtags text[],
                provider_options jsonb,
                signature_text text,
                attachment_ids uuid[]
              )
        WHERE distribution.post_id = $2::uuid
          AND distribution.id = target.distribution_id
          AND distribution.platform_account_id = target.platform_account_id
          AND distribution.status IN ('scheduled', 'queued', 'cancelled')
     RETURNING distribution.id`,
      [
        JSON.stringify(
          rows.map((row) => ({
            attachment_ids: row.target.attachmentIds ?? null,
            description_override: row.target.descriptionOverride ?? null,
            distribution_id: row.distributionId,
            hashtags: row.target.hashtags ?? [],
            platform_account_id: row.platformAccountId,
            provider_options: row.target.providerOptions ?? {},
            signature_text: row.target.signature ?? null,
            title_override: row.target.titleOverride ?? null,
          })),
        ),
        postId,
        status,
        scheduledAt,
      ],
    )
    .pipe(Effect.map((result) => result.rows.map((row) => row.id)));
}

function insertPendingDistributionsEffect(
  client: EffectTransactionClient,
  organizationId: string,
  post: PostMutationRow,
  postId: string,
  rows: readonly ResolvedTargetRow[],
  status: Schemas["DistributionStatus"],
  scheduledAt: string | null,
): Effect.Effect<string[], DatabaseError> {
  if (rows.length === 0) return Effect.succeed([]);
  return client
    .query<{ id: string }>(
      `INSERT INTO distributions
         (org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, scheduled_at, title_override, description_override, hashtags,
          provider_options, signature_text, attachment_ids)
       SELECT $1::uuid, $2::uuid, $3::uuid, selected.platform_account_id,
              selected.platform, $5::text, $6::timestamptz,
              selected.title_override, selected.description_override,
              selected.hashtags, selected.provider_options,
              selected.signature_text, selected.attachment_ids
         FROM jsonb_to_recordset($4::jsonb) AS selected(
                platform_account_id uuid,
                platform text,
                title_override text,
                description_override text,
                hashtags text[],
                provider_options jsonb,
                signature_text text,
                attachment_ids uuid[]
              )
    ON CONFLICT (post_id, platform_account_id) DO NOTHING
     RETURNING id`,
      [
        organizationId,
        post.brand_profile_id,
        postId,
        JSON.stringify(
          rows.map((row) => ({
            attachment_ids: row.target.attachmentIds ?? null,
            description_override: row.target.descriptionOverride ?? null,
            hashtags: row.target.hashtags ?? [],
            platform: row.platform,
            platform_account_id: row.platformAccountId,
            provider_options: row.target.providerOptions ?? {},
            signature_text: row.target.signature ?? null,
            title_override: row.target.titleOverride ?? null,
          })),
        ),
        status,
        scheduledAt,
      ],
    )
    .pipe(Effect.map((result) => result.rows.map((row) => row.id)));
}

function cancelPendingDistributionsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `WITH cancelled AS (
         UPDATE distributions
            SET status = 'cancelled', updated_at = now()
          WHERE post_id = $1
            AND status IN ('scheduled', 'queued')
          RETURNING id
       ), disarmed AS (
         UPDATE distributions
            SET next_attempt_at = NULL, updated_at = now()
          WHERE post_id = $1
            AND status = 'failed'
            AND next_attempt_at IS NOT NULL
       )
       DELETE FROM outbox_events
        WHERE aggregate_id IN (SELECT id FROM cancelled)
          AND topic = 'distribution.publish.requested'
          AND state IN ('pending', 'failed')`,
      [postId],
    )
    .pipe(Effect.asVoid);
}

export function createPostApiService(
  configuredCapabilities = new ProviderRegistry().capabilities(),
): PostApiService {
  const capabilities = new Map(
    configuredCapabilities.map((capability) => [capability.platform, structuredClone(capability)]),
  );
  return {
    createPost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      input: CreatePostInput,
      idempotencyKey: string,
    ) {
      return withTenantIdempotentMutation<Post, PostServiceError>(
        env,
        session,
        "create-post",
        idempotencyKey,
        JSON.stringify(input),
        201,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* lockOrganizationEffect(client, organizationId);
            yield* requireActiveBrandProfileEffect(client, organizationId, input.brandProfileId);
            const attachmentIds = input.attachmentIds ?? [];
            const targets = input.targets ?? [];
            yield* validateCompositionEffect(
              input.title ?? "",
              input.defaultText ?? "",
              attachmentIds,
              targets,
            );
            yield* lockAttachmentAssetsEffect(client, input.brandProfileId, attachmentIds);
            yield* validateTargetScopesEffect(
              client,
              organizationId,
              input.brandProfileId,
              targets,
            );
            const inserted = yield* client.query<PostRow>(
              `INSERT INTO posts (org_id, brand_profile_id, title, default_text, status)
               VALUES ($1, $2, $3, $4, 'draft')
               RETURNING ${postColumns}`,
              [organizationId, input.brandProfileId, input.title ?? "", input.defaultText ?? ""],
            );
            const post = inserted.rows[0]!;
            if (attachmentIds.length > 0)
              yield* replaceAttachmentsEffect(client, post, attachmentIds, []);
            if (targets.length > 0) yield* replaceTargetsEffect(client, post, targets);
            return yield* assembleSinglePostEffect(client, post, {
              distributions: new Map<string, Schemas["Distribution"][]>([[post.id, []]]),
              ...(attachmentIds.length === 0
                ? { attachments: new Map<string, Schemas["PostAttachment"][]>([[post.id, []]]) }
                : {}),
              ...(targets.length === 0
                ? { targets: new Map<string, Schemas["PostTarget"][]>([[post.id, []]]) }
                : {}),
            });
          }),
      );
    },

    listPosts(env: ApiWorkerEnv, session: SessionClaims, filters: PostFilters) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const values: unknown[] = [];
          const conditions: string[] = [
            "posts.deleted_at IS NULL",
            activeBrandProfilePredicate("posts.brand_profile_id"),
          ];
          const parameter = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
          };
          if (filters.status) {
            conditions.push(`posts.status = ${parameter(filters.status)}`);
          }
          if (filters.brandProfileId) {
            conditions.push(`posts.brand_profile_id = ${parameter(filters.brandProfileId)}`);
          }
          if (filters.queueId) {
            const window = filters.queueWindow
              ? `AND membership.assigned_at >= ${parameter(filters.queueWindow.start)}
                 AND membership.assigned_at < ${parameter(filters.queueWindow.end)}`
              : "";
            conditions.push(`EXISTS (SELECT 1 FROM publishing_queue_memberships membership
              WHERE membership.post_id = posts.id AND membership.queue_id = ${parameter(filters.queueId)}
                AND membership.released_at IS NULL ${window})`);
          }
          values.push(filters.limit + 1, filters.offset);
          const result = yield* client.query<PostRow>(
            `SELECT ${postColumns}
               FROM posts
              WHERE ${conditions.join(" AND ")}
              ORDER BY posts.created_at DESC, posts.id DESC
              LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          );
          const page = result.rows.slice(0, filters.limit);
          const posts = yield* assemblePostsEffect(client, page);
          return {
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
            posts,
          };
        }),
      );
    },

    getPost(env: ApiWorkerEnv, session: SessionClaims, postId: string) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<PostRow>(
            `SELECT ${postColumns}
               FROM posts
              WHERE posts.id = $1
                AND posts.deleted_at IS NULL
                AND ${activeBrandProfilePredicate("posts.brand_profile_id")}`,
            [postId],
          );
          const row = result.rows[0];
          if (!row) {
            return yield* Effect.fail(
              new CoreApiError(404, "post_not_found", "The post was not found."),
            );
          }
          const value = yield* assembleSinglePostEffect(client, row);
          return value;
        }),
      );
    },

    updatePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      postId: string,
      input: UpdatePostInput,
      idempotencyKey: string,
    ) {
      return withTenantIdempotentMutation<Post, PostServiceError>(
        env,
        session,
        "update-post",
        idempotencyKey,
        JSON.stringify({ postId, ...input }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* lockOrganizationEffect(client, organizationId);
            const post = yield* lockPostEffect(client, postId);
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: toCoreApiErrorOrRethrow,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            const currentAttachmentIds = yield* loadPostAttachmentIdsEffect(client, postId);
            const attachmentIds = input.attachmentIds ?? currentAttachmentIds;
            const attachmentChange = input.attachmentIds !== undefined;
            const targets = input.targets;
            const effectiveTargets =
              targets ??
              (!(input.defaultText ?? post.default_text).trim() && attachmentIds.length === 0
                ? (yield* loadSavedTargetsEffect(client, postId)).inputs
                : []);
            yield* validateCompositionEffect(
              input.title ?? post.title,
              input.defaultText ?? post.default_text,
              attachmentIds,
              effectiveTargets,
              targets ?? [],
            );
            if (attachmentChange) {
              yield* lockAttachmentAssetsEffect(
                client,
                post.brand_profile_id,
                attachmentIds,
                currentAttachmentIds,
              );
            }
            if (targets) {
              yield* validateTargetScopesEffect(
                client,
                organizationId,
                post.brand_profile_id,
                targets,
              );
              yield* replaceTargetsEffect(client, post, targets);
            }
            if (attachmentChange) {
              yield* replaceAttachmentsEffect(client, post, attachmentIds, currentAttachmentIds);
            }
            const updated = yield* updatePostRowEffect(client, postId, {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.defaultText !== undefined ? { defaultText: input.defaultText } : {}),
            });
            return yield* assembleSinglePostEffect(client, updated);
          }),
      );
    },

    schedulePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      postId: string,
      input: SchedulePostInput,
      idempotencyKey: string,
      requestId?: string,
    ) {
      return withTenantIdempotentMutation<Post, PostServiceError>(
        env,
        session,
        "schedule-post",
        idempotencyKey,
        JSON.stringify({
          postId,
          ...input,
          scheduledAt: input.scheduledAt?.toISOString() ?? null,
        }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* lockOrganizationEffect(client, organizationId);
            const post = yield* lockPostEffect(client, postId);
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: toCoreApiErrorOrRethrow,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            if (!input.queueId && post.queue_membership !== null) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "queue_membership_exists",
                  "Remove this Post from its Queue before manually changing its Schedule.",
                ),
              );
            }
            const saved = input.targets ? undefined : yield* loadSavedTargetsEffect(client, postId);
            const targets = input.targets ?? saved!.inputs;
            const preloadTargets =
              saved === undefined
                ? undefined
                : new Map([[postId, saved.rows.map((row) => mapTarget(row))]]);
            if (targets.length === 0) {
              return yield* Effect.fail(
                new CoreApiError(
                  422,
                  "validation_error",
                  "Scheduling requires at least one channel target.",
                ),
              );
            }
            if (targets.length > 20) {
              return yield* Effect.fail(
                new CoreApiError(
                  422,
                  "validation_error",
                  "targets must contain at most 20 entries.",
                ),
              );
            }
            const attachmentIds = yield* loadPostAttachmentIdsEffect(client, postId);
            const preloadAttachments =
              attachmentIds.length === 0
                ? new Map<string, Schemas["PostAttachment"][]>([[postId, []]])
                : undefined;
            yield* validateCompositionEffect(post.title, post.default_text, attachmentIds, targets);
            const now = new Date();
            const existing = yield* client.query<DistributionSummaryRow>(
              `SELECT distribution.id, distribution.platform_account_id,
                      distribution.status,
                      ${providerOwnedDistributionSql("distribution")} AS provider_owned
                 FROM distributions AS distribution
                WHERE distribution.post_id = $1
                FOR UPDATE`,
              [postId],
            );
            const byAccount = new Map(
              existing.rows
                .filter(
                  (
                    row,
                  ): row is DistributionSummaryRow & {
                    platform_account_id: string;
                  } => row.platform_account_id !== null,
                )
                .map((row) => [row.platform_account_id, row]),
            );
            const actionable: {
              distributionId: string | null;
              selection: readonly string[];
              target: PostTargetInput;
            }[] = [];
            for (const target of targets) {
              const current = byAccount.get(target.platformAccountId);
              if (
                current !== undefined &&
                !isPendingDistribution(current.status) &&
                (current.status !== "cancelled" || current.provider_owned)
              ) {
                continue;
              }
              actionable.push({
                distributionId: current?.id ?? null,
                selection: target.attachmentIds ?? attachmentIds,
                target,
              });
            }
            const accounts = yield* loadAccountsEffect(
              client,
              organizationId,
              actionable.map((entry) => entry.target.platformAccountId),
            );
            const candidates = yield* loadRenditionCandidatesEffect(client, [
              ...new Set(actionable.flatMap((entry) => entry.selection)),
            ]);
            const pending: PendingTargetRow[] = [];
            const created: ResolvedTargetRow[] = [];
            for (const entry of actionable) {
              const account = accounts.get(entry.target.platformAccountId);
              const row = yield* validateTargetScheduleEffect(
                post,
                entry.target,
                entry.selection,
                account,
                account?.platform ? capabilities.get(account.platform) : undefined,
                candidates,
                now,
              );
              if (entry.distributionId === null) {
                created.push(row);
              } else {
                pending.push({ ...row, distributionId: entry.distributionId });
              }
            }
            if (created.length > 0) {
              yield* usageGuardEffect(client, organizationId, created.length);
            }
            if (input.queueId && actionable.length === 0) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "invalid_state",
                  "This Post has no editable publication targets.",
                ),
              );
            }
            const deliveryAt = input.queueId
              ? yield* reserveQueueSlotEffect(
                  client,
                  organizationId,
                  post.brand_profile_id,
                  postId,
                  input.queueId,
                  new Date(),
                )
              : input.scheduledAt;
            const scheduled =
              deliveryAt !== null &&
              deliveryAt !== undefined &&
              deliveryAt.getTime() > now.getTime();
            const status = scheduled ? ("scheduled" as const) : ("queued" as const);
            const scheduledAt = deliveryAt?.toISOString() ?? null;
            const rescheduledIds = yield* reschedulePendingDistributionsEffect(
              client,
              postId,
              pending,
              status,
              scheduledAt,
            );
            const createdIds = yield* insertPendingDistributionsEffect(
              client,
              organizationId,
              post,
              postId,
              created,
              status,
              scheduledAt,
            );
            const command = {
              now,
              requestId,
              scheduledAt: scheduled ? deliveryAt : null,
            };
            yield* insertOutboxBatchEffect(client, organizationId, createdIds, command);
            if (rescheduledIds.length > 0) {
              yield* deletePendingDistributionOutboxEffect(client, rescheduledIds);
              yield* insertOutboxBatchEffect(
                client,
                organizationId,
                rescheduledIds,
                scheduled
                  ? command
                  : { ...command, retryToken: yield* hashIdempotencyRequestEffect(idempotencyKey) },
              );
            }
            const requested = new Set(targets.map((target) => target.platformAccountId));
            const dropped = existing.rows.filter(
              (row) =>
                row.platform_account_id !== null &&
                !requested.has(row.platform_account_id) &&
                isPendingDistribution(row.status),
            );
            if (dropped.length > 0) {
              const droppedIds = dropped.map((row) => row.id);
              yield* client.query(
                `WITH cancelled AS (
                   UPDATE distributions
                      SET status = 'cancelled', updated_at = now()
                    WHERE id = ANY($1::uuid[])
                 )
                 DELETE FROM outbox_events
                  WHERE aggregate_id = ANY($1::uuid[])
                    AND topic = 'distribution.publish.requested'
                    AND state IN ('pending', 'failed')`,
                [droppedIds],
              );
            }
            if (input.targets) {
              yield* replaceTargetsEffect(client, post, targets);
            }
            const updated = yield* updatePostRowEffect(client, postId, {
              activate: true,
            });
            return yield* assembleSinglePostEffect(client, updated, {
              ...(preloadAttachments ? { attachments: preloadAttachments } : {}),
              ...(preloadTargets ? { targets: preloadTargets } : {}),
            });
          }),
      );
    },

    deletePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      postId: string,
      input: DeletePostInput,
      idempotencyKey: string,
    ) {
      return withTenantIdempotentMutation<Post, PostServiceError>(
        env,
        session,
        "delete-post",
        idempotencyKey,
        JSON.stringify({ brandProfileId: input.brandProfileId, postId }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            const post = yield* lockPostEffect(client, postId);
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: toCoreApiErrorOrRethrow,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            if (session.organizationRole !== "admin") {
              const published = yield* client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM distributions
                   WHERE post_id = $1 AND status = ANY($2::text[])
                 ) AS exists`,
                [postId, providerReachedDistributionStatuses],
              );
              if (published.rows[0]?.exists === true) {
                return yield* Effect.fail(
                  new CoreApiError(
                    403,
                    "workspace_admin_required",
                    "Only a workspace admin can delete a post that has published distributions.",
                  ),
                );
              }
            }
            yield* cancelPendingDistributionsEffect(client, postId);
            if (post.queue_membership !== null) yield* releaseQueueMembershipEffect(client, postId);
            yield* lockPostAttachmentAssetsEffect(client, postId);
            yield* client.query("DELETE FROM post_attachments WHERE post_id = $1", [postId]);
            yield* client.query("DELETE FROM post_targets WHERE post_id = $1", [postId]);
            const deleted = yield* client.query<PostRow>(
              `UPDATE posts
                  SET deleted_at = now(), revision = revision + 1, updated_at = now()
                WHERE id = $1
                RETURNING ${postColumns}`,
              [postId],
            );
            return yield* assembleSinglePostEffect(client, deleted.rows[0]!, {
              attachments: new Map<string, Schemas["PostAttachment"][]>([[postId, []]]),
              targets: new Map<string, Schemas["PostTarget"][]>([[postId, []]]),
            });
          }),
      );
    },
  };
}
