import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { isoDateTime, type DatabaseError } from "@meltiply/domain";
import {
  composeCaption,
  ProviderRegistry,
  validatePublishInput,
  type ProviderMedia,
  type ProviderPublishOptions,
} from "@meltiply/providers";

import { mapAsset, type AssetRow } from "./asset-types";
import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import { CoreApiError } from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect,
  type EffectTransactionClient,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";
import {
  distributionColumns,
  insertOutboxBatchEffect,
  mapDistribution,
  publicationSnapshotColumn,
  toWireProviderOptions,
  usageGuardEffect,
  validateTargetOverrides,
} from "./distribution-service";
import type {
  CreatePostInput,
  DeletePostInput,
  PostApiService,
  PostFilters,
  PostServiceError,
  PostTargetInput,
  SchedulePostInput,
  UpdatePostInput,
} from "./post-types";

type Schemas = components["schemas"];
type Platform = Schemas["Platform"];
type PlatformCapability = Schemas["PlatformCapability"];
type Post = Schemas["Post"];
type PostStatus = Schemas["PostStatus"];

const postColumns = `
  id, org_id, brand_profile_id, title, default_text, status, revision,
  created_at, updated_at`;

/**
 * Columns selected for every attachment projection. `r2_key` no longer lives on
 * `assets`; object addresses belong to the `asset_objects` inventory and are
 * only reachable through the scoped per-Asset preview/download endpoints.
 */
const assetColumns = `
  asset.id, asset.org_id, asset.brand_profile_id, asset.uploaded_by,
  asset.asset_type, asset.title, asset.duration_sec, asset.file_size,
  asset.mime_type, asset.width, asset.height, asset.original_filename,
  asset.status, asset.failure_code, asset.failure_message,
  asset.failure_retryable, asset.failure_at, asset.created_at, asset.updated_at`;

interface PostRow extends Record<string, unknown> {
  brand_profile_id: string;
  created_at: Date | string;
  default_text: string;
  deleted_at: Date | string | null;
  id: string;
  org_id: string;
  revision: number | string;
  status: PostStatus;
  title: string;
  updated_at: Date | string;
}

/**
 * One saved target row.
 *
 * The stored `provider_options` column holds the provider-domain camelCase
 * shape the publishing worker reads back; `mapTarget` converts it to the
 * contract's snake_case wire shape on the way out. `post_id` is only present on
 * the grouped collection read; the single-Post schedule read omits it.
 */
interface TargetRow extends Record<string, unknown> {
  attachment_ids: string[] | null;
  description_override: string | null;
  hashtags: string[] | null;
  platform_account_id: string;
  post_id?: string;
  provider_options: ProviderPublishOptions | null;
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

/**
 * One `post_attachments` row joined to its Asset: the ordered attachment
 * position plus the full Asset projection the response embeds.
 */
interface AttachmentRow extends Record<string, unknown> {
  asset_id: string;
  position: number | string;
  post_id: string;
}

/**
 * A verified ready object an attachment may publish from: a processed rendition
 * or, when optimization produced no benefit, the verified original.
 */
interface CandidateRow extends Record<string, unknown> {
  asset_id: string;
  bytes: number | string;
  content_type: string;
  duration_sec: number | string | null;
  height: number | string | null;
  width: number | string | null;
}

/**
 * One existing Distribution of a Post as the schedule decision reads it: the
 * Channel it serves, the outcome it currently holds, and whether any provider
 * attempt already owns that outcome.
 */
interface DistributionSummaryRow extends Record<string, unknown> {
  id: string;
  platform_account_id: string | null;
  provider_owned: boolean;
  status: Schemas["DistributionStatus"];
}

/**
 * One validated target paired with the Platform its account resolves to.
 *
 * Validation already proved the account exists and belongs to the Post's Brand
 * Profile, so the write path no longer needs the account row — only the
 * resolved platform literal plus the settings that were validated against it.
 */
interface ResolvedTargetRow {
  platform: Platform;
  platformAccountId: string;
  target: PostTargetInput;
}

/**
 * One validated target whose Distribution row already exists.
 *
 * Scheduling addresses the pending rows by the id its locked read observed
 * rather than by re-deriving them from the Channel, so the statement cannot
 * apply one intent to a different row than the one the decision was made for.
 */
interface PendingTargetRow extends ResolvedTargetRow {
  distributionId: string;
}

interface PostCollections {
  analytics: Map<string, Schemas["PostAnalytics"]>;
  attachments: Map<string, Schemas["PostAttachment"][]>;
  distributions: Map<string, Schemas["Distribution"][]>;
  targets: Map<string, Schemas["PostTarget"][]>;
}

/** Latest measured counters grouped by Post; PostgreSQL SUM(bigint) returns numeric text. */
interface PostAnalyticsRow extends Record<string, unknown> {
  post_id: string;
  likes: number | string;
  comments: number | string;
  shares: number | string;
  views: number | string;
  impressions: number | string;
  reach: number | string;
}

/**
 * Keeps expected validation errors typed without asserting unknown exceptions
 * are client failures. Rethrowing unexpected errors lets Effect record defects
 * for the existing dies-first API boundary rather than misclassifying them.
 */
function validationError(cause: unknown): CoreApiError {
  if (cause instanceof CoreApiError) return cause;
  throw cause;
}

/** Distribution statuses a creator may still create, edit, or cancel. */
const EDITABLE_DISTRIBUTION_STATUSES: ReadonlySet<Schemas["DistributionStatus"]> = new Set([
  "scheduled",
  "queued",
]);

/**
 * Maps a saved target row onto the public `PostTarget` read model.
 *
 * Provider options are stored as JSON `{}` when a Channel has no explicit
 * choices, which reads back as `null` so clients can tell "nothing saved" from
 * an intentionally empty selection. `attachment_ids` stays `null` when the
 * target inherits the Post's attachments and `[]` when it is text-only.
 *
 * @param row - Database row from `post_targets`.
 * @returns Contract `PostTarget` representation.
 */
function mapTarget(row: TargetRow): Schemas["PostTarget"] {
  return {
    attachment_ids: row.attachment_ids ?? null,
    description_override: row.description_override,
    hashtags: row.hashtags ?? [],
    platform_account_id: row.platform_account_id,
    provider_options: toWireProviderOptions(row.provider_options),
    title_override: row.title_override,
  };
}

/**
 * Collections a caller already holds from the current transaction.
 *
 * A mutation path reads the authoritative rows it is about to write or return —
 * a Post's saved targets, its ordered attachment ids — and re-reading the same
 * collection to build the response would be a second identical statement inside
 * one transaction. Passing those rows through lets the projection reuse them.
 * `attachments` additionally carries the joined Asset facts, which the ordered
 * id list alone cannot supply, so it is only reusable once the caller has them.
 */
interface PostCollectionPreloads {
  attachments?: Map<string, Schemas["PostAttachment"][]>;
  distributions?: Map<string, Schemas["Distribution"][]>;
  targets?: Map<string, Schemas["PostTarget"][]>;
}

/**
 * Loads ordered attachments, saved targets, publication outcomes, and measured
 * analytics for requested Posts and groups them per Post id.
 *
 * One query per collection prevents join fan-out. Analytics uses one bounded
 * latest-snapshot lookup per published Distribution inside a single statement,
 * then sums per Post; older snapshots and unpublished Channels never contribute.
 * No snapshot means no analytics object, not zero. Draft-only batches skip that
 * statement. Caller-supplied collection preloads are not read again, including
 * the known-empty distributions of a newly inserted Post.
 *
 * @param client - Active tenant transaction client.
 * @param postIds - Post identifiers already read and authorized by the caller.
 * @param preloads - Collections already loaded in this transaction, keyed by Post id.
 * @returns Effect resolving to the collections and latest measured Post analytics.
 */
function loadPostCollectionsEffect(
  client: EffectTransactionClient,
  postIds: readonly string[],
  preloads: PostCollectionPreloads = {},
): Effect.Effect<PostCollections, PostServiceError> {
  return Effect.gen(function* () {
    const collections: PostCollections = {
      analytics: new Map(),
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
                description_override, hashtags, provider_options, attachment_ids
           FROM post_targets
          WHERE post_id = ANY($1::uuid[])
          ORDER BY post_id, created_at, platform_account_id`,
        [postIds],
      );
      for (const row of targetRows.rows) {
        // The grouped read always selects post_id; the optional marker exists
        // only because the single-Post schedule read omits it.
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
        `SELECT d.post_id,
                SUM(snapshot.likes) AS likes,
                SUM(snapshot.comments) AS comments,
                SUM(snapshot.shares) AS shares,
                SUM(snapshot.views) AS views,
                SUM(snapshot.impressions) AS impressions,
                SUM(snapshot.reach) AS reach
           FROM distributions d
           JOIN LATERAL (
             SELECT likes, comments, shares, views, impressions, reach
               FROM analytics_snapshots
              WHERE distribution_id = d.id
              ORDER BY snapshot_at DESC, id DESC
              LIMIT 1
           ) snapshot ON true
          WHERE d.post_id = ANY($1::uuid[]) AND d.status = 'published'
          GROUP BY d.post_id`,
        [postIds],
      );
      for (const row of analyticsRows.rows) {
        collections.analytics.set(row.post_id, {
          likes: Number(row.likes),
          comments: Number(row.comments),
          shares: Number(row.shares),
          saves: null,
          clicks: null,
          views: Number(row.views),
          impressions: Number(row.impressions),
          reach: Number(row.reach),
        });
      }
    }
    return collections;
  });
}

/**
 * Assembles one Post read model from its row and its loaded collections.
 *
 * `status` is a lifecycle marker derived from whether the Post has any target
 * yet, never a global publication outcome: per-Channel success and failure
 * stay readable from `distributions`.
 *
 * @param row - Stored Post row.
 * @param collections - Per-Post attachments, targets, and distributions.
 * @returns Contract `Post` representation.
 */
function assemblePost(row: PostRow, collections: PostCollections): Post {
  return {
    analytics: collections.analytics.get(row.id) ?? null,
    attachments: collections.attachments.get(row.id) ?? [],
    brand_profile_id: row.brand_profile_id,
    created_at: isoDateTime(row.created_at),
    default_text: row.default_text,
    distributions: collections.distributions.get(row.id) ?? [],
    id: row.id,
    org_id: row.org_id,
    revision: Number(row.revision),
    status: row.status,
    targets: collections.targets.get(row.id) ?? [],
    title: row.title,
    updated_at: isoDateTime(row.updated_at),
  };
}

/**
 * Assembles the response for one or more already-authorized Post rows.
 *
 * @param client - Active tenant transaction client.
 * @param rows - Post rows to project.
 * @param preloads - Collections already loaded in this transaction, keyed by Post id.
 * @returns Effect resolving to the assembled Post read models.
 */
function assemblePostsEffect(
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

/**
 * Assembles the response for exactly one already-authorized Post row.
 *
 * Every mutation reads and returns a single Post, so projecting one row through
 * the shared collection loader keeps the projection identical to the list and
 * read paths while making the "exactly one Post" contract explicit at the type
 * level instead of destructuring an array that could be empty.
 *
 * @param client - Active tenant transaction client.
 * @param row - Post row to project.
 * @param preloads - Collections already loaded in this transaction, keyed by Post id.
 * @returns Effect resolving to the assembled Post read model.
 */
function assembleSinglePostEffect(
  client: EffectTransactionClient,
  row: PostRow,
  preloads: PostCollectionPreloads = {},
): Effect.Effect<Post, PostServiceError> {
  return loadPostCollectionsEffect(client, [row.id], preloads).pipe(
    Effect.map((collections) => assemblePost(row, collections)),
  );
}

/**
 * Locks one retained Post for mutation.
 *
 * The row lock serializes concurrent saves, schedules, and deletes of the same
 * Post, so an attachment replacement, target diff, and publication writes always
 * observe one consistent revision. A soft-deleted Post is indistinguishable
 * from a missing one so a retired identity never reappears through any read.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post UUID being mutated.
 * @returns Effect resolving to the locked Post row.
 * @throws {CoreApiError} 404 `post_not_found` when the Post is missing, owned by another workspace, or deleted.
 */
function lockPostEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<PostRow, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* client.query<PostRow>(
      `SELECT ${postColumns}, deleted_at
         FROM posts
        WHERE id = $1 AND org_id = public.auth_active_org_id()
        FOR UPDATE`,
      [postId],
    );
    const row = result.rows[0];
    if (!row || row.deleted_at !== null) {
      return yield* Effect.fail(new CoreApiError(404, "post_not_found", "The post was not found."));
    }
    return row;
  });
}

/**
 * Locks every Asset currently attached to a Post in ascending Asset id order.
 *
 * The detach trigger locks each Asset as the attachment row is removed, so a
 * deletion transaction must acquire those locks first and in the same global
 * order a composition write uses. Otherwise two concurrent deletions of Posts
 * that share media could each hold one Asset and wait for the other.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post whose attached Assets are about to be detached.
 * @returns Effect resolving once every attached Asset row is locked.
 */
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

/**
 * Rejects a mutation that targets a different Brand Profile than the Post's.
 *
 * Composer mutations are scoped to one Brand Profile so content cannot move
 * between publishing identities; a mismatch is a client mistake rather than a
 * missing resource, because the Post itself is visible.
 *
 * @param post - Locked Post row.
 * @param brandProfileId - Brand Profile the request asserted.
 * @throws {CoreApiError} 422 `brand_profile_mismatch` when the profiles differ.
 */
function requireMatchingBrandProfile(post: PostRow, brandProfileId: string): void {
  if (post.brand_profile_id !== brandProfileId) {
    throw new CoreApiError(
      422,
      "brand_profile_mismatch",
      "The post belongs to a different brand profile.",
    );
  }
}

/**
 * Locks every Asset a composition write will touch and validates the ones being
 * attached.
 *
 * An attachment is what retains stored media, so attaching proves the Asset
 * belongs to the same Brand Profile, is not already claimed for deletion, and —
 * for an upload still in flight — belongs to a session that has not expired.
 *
 * All assets, including ones being detached, are locked in ascending Asset id
 * order. The attachment triggers lock each Asset while detaching or inserting,
 * so a transaction that reaches a trigger holding a lock this one acquires
 * first would otherwise deadlock. One global order across create, update, and
 * delete removes those cycles without serializing unrelated Posts.
 *
 * @param client - Active tenant transaction client.
 * @param brandProfileId - Brand Profile that will own the attachments.
 * @param attachmentIds - Ordered, de-duplicated Asset identifiers being attached.
 * @param alsoLockIds - Additional Assets the same transaction will detach; they
 *   are locked but not revalidated because their ownership was proven when attached.
 * @returns Effect resolving to the locked asset rows in the requested order.
 * @throws {CoreApiError} 422 `validation_error` when the selection repeats an Asset.
 * @throws {CoreApiError} 404 `asset_not_found` when an Asset is missing or owned by another workspace.
 * @throws {CoreApiError} 422 `brand_profile_mismatch` when an Asset belongs to another Brand Profile.
 * @throws {CoreApiError} 409 `asset_not_attachable` when an Asset is being deleted or its upload session expired.
 */
function lockAttachmentAssetsEffect(
  client: EffectTransactionClient,
  brandProfileId: string,
  attachmentIds: readonly string[],
  alsoLockIds: readonly string[] = [],
): Effect.Effect<AssetRow[], CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      return yield* Effect.fail(
        new CoreApiError(422, "validation_error", "attachment_ids must not repeat an asset."),
      );
    }
    const lockIds = [...new Set([...alsoLockIds, ...attachmentIds])].sort();
    if (lockIds.length === 0) return [];
    const locked = yield* client.query<AssetRow>(
      `SELECT ${assetColumns},
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
    return attachmentIds.map((assetId) => byId.get(assetId)!);
  });
}

/**
 * Replaces the complete ordered attachment set of one Post.
 *
 * A save is authoritative over the whole selection: omitted Assets are detached
 * — which restarts their orphan grace period through the database trigger — and
 * supplied Assets are attached in the given order. Replacing rather than
 * merging is what makes reorder, remove, and replace one atomic edit that never
 * disturbs the caption or the saved channel settings. An unchanged selection is
 * a no-op so a text-only save never churns attachment retention.
 *
 * @param client - Active tenant transaction client.
 * @param post - Locked Post row owning the Brand Profile.
 * @param assetIds - Complete ordered attachment selection.
 * @param previousIds - Current ordered attachment ids when the caller already
 *   read them; omitted means the current set is not known yet.
 * @returns Effect resolving once the attachment set matches `assetIds`.
 */
function replaceAttachmentsEffect(
  client: EffectTransactionClient,
  post: PostRow,
  assetIds: readonly string[],
  previousIds?: readonly string[],
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const previous =
      previousIds ??
      (yield* client
        .query<{ asset_id: string }>(
          `SELECT asset_id FROM post_attachments WHERE post_id = $1 ORDER BY position`,
          [post.id],
        )
        .pipe(Effect.map((result) => result.rows.map((row) => row.asset_id))));
    if (
      previous.length === assetIds.length &&
      previous.every((id, index) => id === assetIds[index])
    ) {
      return;
    }
    // Detaching first lets the trigger restart the orphan clock only for Assets
    // that truly lose their last retained reference, so an Asset that is
    // re-attached by the same save never enters the orphan sweep.
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

/**
 * Replaces the complete saved target set of one Post.
 *
 * Per-Channel settings persist independently of publication so a creator can
 * record captions, hashtags, and attachment selections before scheduling
 * anything. Replacement is all-or-nothing: a save that omits a Channel drops
 * it, and one that names it updates it in place.
 *
 * @param client - Active tenant transaction client.
 * @param post - Locked Post row.
 * @param targets - Complete saved target selection.
 * @returns Effect resolving once the saved target set matches `targets`.
 * @throws {CoreApiError} 422 `validation_error` when the same Channel appears twice.
 */
function replaceTargetsEffect(
  client: EffectTransactionClient,
  post: PostRow,
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
          attachment_ids)
       SELECT $1::uuid, selected.platform_account_id, $3::uuid, $4::uuid,
              selected.title_override, selected.description_override,
              selected.hashtags, selected.provider_options,
              selected.attachment_ids
         FROM jsonb_to_recordset($2::jsonb) AS selected(
           platform_account_id uuid,
           title_override text,
           description_override text,
           hashtags text[],
           provider_options jsonb,
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
            title_override: target.titleOverride ?? null,
          })),
        ),
        post.org_id,
        post.brand_profile_id,
      ],
    );
  });
}

/**
 * Loads the saved target rows of one Post as schedule-time target inputs,
 * together with the same rows in stored shape.
 *
 * Scheduling both validates these settings and returns them in the response,
 * so the raw rows travel with the parsed inputs: the response projection then
 * reuses the authoritative rows this statement already read instead of issuing
 * a second identical `post_targets` query inside the same transaction.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post whose saved targets are requested.
 * @returns Effect resolving to the parsed targets and their stored rows.
 */
function loadSavedTargetsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<{ inputs: PostTargetInput[]; rows: TargetRow[] }, DatabaseError> {
  return client
    .query<TargetRow>(
      `SELECT platform_account_id, title_override, description_override,
              hashtags, provider_options, attachment_ids
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
          titleOverride: row.title_override,
        })),
        rows: result.rows,
      })),
    );
}

/**
 * Rejects a per-target attachment selection that is not part of the Post.
 *
 * Channel-specific media narrows a publication to a subset of the Post's own
 * ordered attachments; referencing foreign media would invent a second
 * composition identity outside this Post.
 *
 * @param targets - Targets whose selection is validated.
 * @param attachmentIds - The Post's effective ordered attachment selection.
 * @throws {CoreApiError} 422 `validation_error` when a target selects an Asset the Post does not attach.
 */
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

/**
 * Rejects saved targets that name Channels the Brand Profile does not own.
 *
 * Draft saves record channel settings before anything is published, so the
 * ownership check still applies: settings must never stage a publication toward
 * another profile's Channel.
 *
 * @param client - Active tenant transaction client.
 * @param organizationId - Active workspace UUID.
 * @param brandProfileId - Brand Profile that owns the Post and its targets.
 * @param targets - Targets to verify.
 * @returns Effect resolving once every target names an owned Channel.
 * @throws {CoreApiError} 404 `platform_account_not_found` when a Channel is missing or foreign.
 * @throws {CoreApiError} 422 `brand_profile_mismatch` when a Channel belongs to another Brand Profile.
 */
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

/**
 * Loads the platform account facts every schedule-time target check needs.
 *
 * A missing Channel simply yields no row, so the caller reports "not found"
 * instead of silently dropping a requested target.
 *
 * @param client - Active tenant transaction client.
 * @param organizationId - Active workspace UUID.
 * @param accountIds - Requested Platform account identifiers.
 * @returns Effect resolving to account rows keyed by account id.
 */
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

/**
 * Loads decoder-approved rendition objects, grouped by attachment and size.
 * An original is eligible only through a ready rendition reference created by
 * the native processor's verified no-benefit outcome; its protected inventory
 * row alone proves storage, not profile or codec compatibility. The owning
 * Asset must itself still be `ready` and not soft-deleted: a rendition that
 * outlived a failed, reprocessing, or reclaiming Asset proves nothing about the
 * bytes the publication would publish, so the reference is skipped rather than
 * scheduled. Multiple profiles referencing the same object are deduplicated.
 * @param client - Active tenant transaction client.
 * @param assetIds - Attachment identifiers selected across every target this
 *   schedule will create or edit; a settled target publishes nothing and is
 *   therefore never asked about its media.
 * @returns Ready candidates ordered by bytes, with object keys breaking ties.
 */
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

/**
 * Enforces the provider-option rules that depend on the resolved media mix.
 *
 * TikTok requires explicit creator choices on every publish, and its Duet and
 * Stitch switches only exist for video. A media-only target must still carry
 * the options, while a TikTok photo target must not claim Duet or Stitch — the
 * same rules the provider adapters enforce at publish time.
 *
 * @param providerOptions - Candidate provider options for the target.
 * @param platform - Target platform.
 * @param selection - Ordered attachment ids the target publishes.
 * @param candidates - Ready objects grouped by asset id.
 * @throws {CoreApiError} 422 `validation_error` when the options cannot apply.
 */
function validateProviderOptions(
  providerOptions: ProviderPublishOptions | undefined,
  platform: Platform,
  selection: readonly string[],
  candidates: ReadonlyMap<string, CandidateRow[]>,
): void {
  const tiktok = providerOptions?.tiktok;
  if (platform !== "tiktok") {
    if (tiktok) {
      throw new CoreApiError(
        422,
        "validation_error",
        "TikTok provider options require a TikTok account.",
      );
    }
    return;
  }
  if (!tiktok || tiktok.musicUsageConfirmed !== true) {
    throw new CoreApiError(
      422,
      "validation_error",
      "TikTok publishing choices and music-usage confirmation are required.",
    );
  }
  const publishesPhoto = selection.some((assetId) =>
    (candidates.get(assetId) ?? []).some((candidate) =>
      candidate.content_type.startsWith("image/"),
    ),
  );
  if (publishesPhoto && (tiktok.allowDuet || tiktok.allowStitch)) {
    throw new CoreApiError(
      422,
      "validation_error",
      "TikTok photo posts do not support Duet or Stitch.",
    );
  }
  if (tiktok.brandContent && tiktok.privacyLevel === "SELF_ONLY") {
    throw new CoreApiError(
      422,
      "validation_error",
      "TikTok branded content cannot use private visibility.",
    );
  }
}

/**
 * Validates one Channel target's resolved publication against its platform.
 *
 * The check mirrors what the publishing worker will actually attempt: the
 * caption composed from the Post and the target's overrides, and the ordered
 * media built from the smallest verified ready object per selected attachment.
 * A target whose media is still processing, whose upload failed, or whose media
 * cannot satisfy the platform fails here rather than after a provider call, and
 * the failure names the offending field so the creator can adjust only that
 * target without disturbing the shared Post.
 *
 * @param post - Locked Post row supplying title and default text.
 * @param target - Effective target settings for one Channel.
 * @param selection - Ordered attachment ids this Channel publishes.
 * @param account - Platform account facts for the target.
 * @param capability - Capability descriptor for the account's platform.
 * @param candidates - Ready objects grouped by asset id, smallest first.
 * @param now - Reference instant for connection-expiry checks.
 * @returns Effect resolving to the target's platform; fails with the actionable cause otherwise.
 */
function validateTargetScheduleEffect(
  post: PostRow,
  target: PostTargetInput,
  selection: readonly string[],
  account: AccountRow | undefined,
  capability: PlatformCapability | undefined,
  candidates: ReadonlyMap<string, CandidateRow[]>,
  now: Date,
): Effect.Effect<Platform, CoreApiError> {
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
    if (
      account.revoked_at ||
      account.connection_status !== "connected" ||
      (account.token_expires_at && new Date(account.token_expires_at).getTime() <= now.getTime())
    ) {
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
    try {
      validateTargetOverrides(target);
      validateProviderOptions(target.providerOptions, platform, selection, candidates);
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
        // Capability checks read the declared facts only; this URL is never
        // fetched during validation, so the check stays pure and offline.
        url: "https://validation.invalid/media",
      });
    }
    const issues = validatePublishInput(capability, {
      caption: composeCaption({
        defaultText: post.default_text,
        descriptionOverride: target.descriptionOverride ?? null,
        hashtags: target.hashtags ?? [],
        title: post.title,
        titleOverride: target.titleOverride ?? null,
      }),
      hashtags: target.hashtags ?? [],
      idempotencyKey: "",
      media,
      ...(target.providerOptions ? { providerOptions: target.providerOptions } : {}),
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
    return Effect.succeed(platform);
  });
}

/**
 * Enforces the Post title and body length limits at the service boundary.
 *
 * @param title - Effective Post title.
 * @param defaultText - Effective Post default text.
 * @throws {CoreApiError} 422 `validation_error` when a field exceeds its contract limit.
 */
function validatePostText(title: string, defaultText: string): void {
  if (title.length > 200) {
    throw new CoreApiError(422, "validation_error", "title is too long.");
  }
  if ([...defaultText].length > 10_000) {
    throw new CoreApiError(422, "validation_error", "default_text is too long.");
  }
}

/**
 * Rejects a Post that would carry neither text nor media.
 *
 * Opening a composer must not create an indefinitely retained empty server
 * draft, so a Post needs text or at least one attachment before it persists.
 *
 * @param defaultText - Effective default text after the requested edit.
 * @param attachmentIds - Effective ordered attachment selection.
 * @throws {CoreApiError} 422 `validation_error` when the result would be empty.
 */
function requireNonEmptyPost(defaultText: string, attachmentIds: readonly string[]): void {
  if (defaultText.trim().length === 0 && attachmentIds.length === 0) {
    throw new CoreApiError(
      422,
      "validation_error",
      "A post requires default_text or at least one attachment.",
    );
  }
}

/**
 * Applies an edited Post field set and bumps its revision in one statement.
 *
 * The revision counter is what lets a client detect that its copy of a draft is
 * stale without comparing whole bodies, so every accepted mutation advances it
 * exactly once regardless of how many rows it touched.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post UUID being updated.
 * @param patch - Field flags and values; `activate` marks the Post as having targets.
 * @returns Effect resolving to the updated Post row.
 */
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

/**
 * Reads the ordered attachment ids currently stored for one Post.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post whose attachment order is requested.
 * @returns Effect resolving to the ordered attachment ids.
 */
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

/**
 * Applies a new delivery intent to every still-editable pending Distribution of
 * one Post in a single statement.
 *
 * Scheduling resolves the whole target set at once, so editing rows one
 * statement at a time would make the write path scale with the Channel count.
 * The resolved settings travel as one JSON payload expanded with
 * `jsonb_to_recordset`, the same set-based shape the insert and saved-target
 * writers use: declaring `hashtags` and `attachment_ids` as arrays keeps each
 * Channel's ordered selection intact, where parallel arrays through `unnest`
 * would have to flatten two nesting levels and pair them position by position.
 * Each payload row names the Distribution id its locked read observed, so a
 * target is applied at most once and only to the row the decision was made
 * against, and the status filter still skips a published, claimed, or
 * reconciliation-bound outcome instead of rewriting it.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post whose pending targets are being rescheduled.
 * @param rows - Resolved per-target settings paired with their existing row ids.
 * @param status - Status every edited row adopts (`scheduled` or `queued`).
 * @param scheduledAt - Delivery instant, or null for immediate publication.
 * @returns Effect resolving to the ids of the rows the statement actually edited.
 */
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
              attachment_ids = target.attachment_ids,
              updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS target(
                distribution_id uuid,
                platform_account_id uuid,
                title_override text,
                description_override text,
                hashtags text[],
                provider_options jsonb,
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

/**
 * Materializes the pending Distribution rows for every target of a Post that
 * does not have one yet, in a single statement.
 *
 * New targets are expanded from one JSON payload with `jsonb_to_recordset`, the
 * same set-based shape the Post target and attachment writers already use, so
 * a twenty-Channel schedule costs one statement rather than twenty. The unique
 * constraint on `(post_id, platform_account_id)` is the database-level
 * guarantee that repeating a scheduling intent cannot produce a duplicate row;
 * conflicting rows are skipped rather than mutated, which preserves any outcome
 * a provider already owns.
 *
 * @param client - Active tenant transaction client.
 * @param organizationId - Active workspace UUID.
 * @param post - Locked Post row supplying ownership.
 * @param postId - Post the Distributions belong to.
 * @param rows - Validated targets with their resolved platform, newest first excluded.
 * @param status - Status the new rows adopt (`scheduled` or `queued`).
 * @param scheduledAt - Delivery instant, or null for immediate publication.
 * @returns Effect resolving to the ids of the created Distribution rows.
 */
function insertPendingDistributionsEffect(
  client: EffectTransactionClient,
  organizationId: string,
  post: PostRow,
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
          provider_options, attachment_ids)
       SELECT $1::uuid, $2::uuid, $3::uuid, selected.platform_account_id,
              selected.platform, $5::text, $6::timestamptz,
              selected.title_override, selected.description_override,
              selected.hashtags, selected.provider_options,
              selected.attachment_ids
         FROM jsonb_to_recordset($4::jsonb) AS selected(
                platform_account_id uuid,
                platform text,
                title_override text,
                description_override text,
                hashtags text[],
                provider_options jsonb,
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
            title_override: row.target.titleOverride ?? null,
          })),
        ),
        status,
        scheduledAt,
      ],
    )
    .pipe(Effect.map((result) => result.rows.map((row) => row.id)));
}

/**
 * Cancels the pending publications of a Post and drops their unleased commands.
 *
 * Only work that has not been claimed is cancelled. Rows a provider attempt or
 * Reconciliation already owns keep their own lifecycle so in-flight media
 * stays protected, and published rows remain as immutable history: local
 * deletion never unpublishes a live Platform copy.
 *
 * Cancellation and command cleanup commit as one statement: the data-modifying
 * CTEs remove the extra round trip a Post with pending work would otherwise
 * pay inside the deletion transaction.
 *
 * @param client - Active tenant transaction client.
 * @param postId - Post whose pending publications are cancelled.
 * @returns Effect resolving once cancellations and outbox cleanup commit.
 */
function cancelPendingDistributionsEffect(
  client: EffectTransactionClient,
  postId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query<{ cancelled_count: number }>(
      `WITH cancelled AS (
         UPDATE distributions
            SET status = 'cancelled', updated_at = now()
          WHERE post_id = $1
            AND status IN ('scheduled', 'queued')
          RETURNING id
       ), dropped AS (
         DELETE FROM outbox_events
          WHERE aggregate_id IN (SELECT id FROM cancelled)
            AND topic = 'distribution.publish.requested'
            AND state IN ('pending', 'failed')
          RETURNING 1
       )
       SELECT (SELECT COUNT(*)::integer FROM cancelled) AS cancelled_count,
              (SELECT COUNT(*)::integer FROM dropped) AS dropped_count`,
      [postId],
    )
    .pipe(Effect.asVoid);
}

/**
 * Factory creating the Post composition service.
 *
 * One Post identity owns default content, ordered attachments, and saved
 * per-Channel settings, and publishing to Channels creates pending Distributions
 * that track outcomes independently. The service owns the draft-save, schedule,
 * and deletion seams that decide retention, while independent per-Distribution
 * reschedule, cancel, retry, and Reconciliation stay in the distribution
 * service.
 *
 * @param configuredCapabilities - Platform capability list (defaults to `ProviderRegistry`).
 * @returns `PostApiService` implementation backed by tenant transactions.
 */
export function createPostApiService(
  configuredCapabilities = new ProviderRegistry().capabilities(),
): PostApiService {
  const capabilities = new Map(
    configuredCapabilities.map((capability) => [capability.platform, structuredClone(capability)]),
  );
  return {
    /**
     * Creates an idempotent draft under the active Brand Profile, retaining
     * Workspace and Asset locks. A new Post has no distributions or analytics;
     * its response reuses those known-empty collections without reading them.
     */
    createPost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      input: CreatePostInput,
      idempotencyKey: string,
    ) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify(input));
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "create-post",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Post,
              };
            }
            yield* lockOrganizationEffect(client, organizationId);
            yield* requireActiveBrandProfileEffect(client, organizationId, input.brandProfileId);
            const attachmentIds = input.attachmentIds ?? [];
            const targets = input.targets ?? [];
            requireNonEmptyPost(input.defaultText ?? "", attachmentIds);
            requireTargetAttachmentScope(targets, attachmentIds);
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
            // A new Post owns no attachment or target rows yet, so an empty
            // selection has nothing to replace and no collection to re-read.
            if (attachmentIds.length > 0)
              yield* replaceAttachmentsEffect(client, post, attachmentIds, []);
            if (targets.length > 0) yield* replaceTargetsEffect(client, post, targets);
            const value = yield* assembleSinglePostEffect(client, post, {
              distributions: new Map<string, Schemas["Distribution"][]>([[post.id, []]]),
              ...(attachmentIds.length === 0
                ? { attachments: new Map<string, Schemas["PostAttachment"][]>([[post.id, []]]) }
                : {}),
              ...(targets.length === 0
                ? { targets: new Map<string, Schemas["PostTarget"][]>([[post.id, []]]) }
                : {}),
            });
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "create-post",
              idempotencyKey,
              201,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
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
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ postId, ...input }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "update-post",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Post,
              };
            }
            yield* lockOrganizationEffect(client, organizationId);
            const post = yield* lockPostEffect(client, postId);
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: validationError,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            const currentAttachmentIds = yield* loadPostAttachmentIdsEffect(client, postId);
            const attachmentIds = input.attachmentIds ?? currentAttachmentIds;
            const attachmentChange = input.attachmentIds !== undefined;
            const targets = input.targets;
            yield* Effect.try({
              try: () => {
                const title = input.title ?? post.title;
                const defaultText = input.defaultText ?? post.default_text;
                validatePostText(title, defaultText);
                requireNonEmptyPost(defaultText, attachmentIds);
                if (targets) requireTargetAttachmentScope(targets, attachmentIds);
              },
              catch: validationError,
            });
            if (attachmentChange) {
              // Lock the union of the current and requested sets in ascending
              // Asset order so the detach and insert triggers cannot form a
              // lock cycle with a concurrent composition write.
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
            const value = yield* assembleSinglePostEffect(client, updated);
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "update-post",
              idempotencyKey,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },

    /**
     * Schedules the explicit or saved Channel targets idempotently with quota
     * enforcement. Existing provider-owned outcomes remain unchanged; dropping
     * editable targets cancels their rows and removes only pending/failed
     * publish commands in one statement, preserving consumer-owned leases.
     */
    schedulePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      postId: string,
      input: SchedulePostInput,
      idempotencyKey: string,
    ) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({
            postId,
            ...input,
            scheduledAt: input.scheduledAt?.toISOString() ?? null,
          }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "schedule-post",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Post,
              };
            }
            yield* lockOrganizationEffect(client, organizationId);
            const post = yield* lockPostEffect(client, postId);
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: validationError,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            const saved = input.targets ? undefined : yield* loadSavedTargetsEffect(client, postId);
            const targets = input.targets ?? saved!.inputs;
            // Scheduling the saved set returns exactly the rows already read, and
            // a text-only Post has no attachments to project, so both collections
            // are handed to the response projection instead of being read again.
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
            // Only a Post that is provably attachment-free can be projected
            // without re-reading: the attachment response embeds each full
            // Asset, which the ordered id list cannot supply, so a Post with any
            // attachment still takes the normal join.
            const preloadAttachments =
              attachmentIds.length === 0
                ? new Map<string, Schemas["PostAttachment"][]>([[postId, []]])
                : undefined;
            yield* Effect.try({
              try: () => {
                requireNonEmptyPost(post.default_text, attachmentIds);
                requireTargetAttachmentScope(targets, attachmentIds);
              },
              catch: validationError,
            });
            const now = new Date();
            // The locked read comes before target validation because it
            // decides which targets this call may still act on: a row whose
            // outcome a provider attempt, a lease, or Reconciliation owns is
            // left alone, so its Channel's lapsed credential or changed media
            // cannot block rescheduling the pending ones.
            const existing = yield* client.query<DistributionSummaryRow>(
              `SELECT distribution.id, distribution.platform_account_id,
                      distribution.status,
                      (distribution.attempt_count > 0
                       OR distribution.last_attempt_at IS NOT NULL
                       OR distribution.provider_operation_id IS NOT NULL
                       OR distribution.published_at IS NOT NULL
                       OR distribution.platform_post_id IS NOT NULL
                       OR distribution.cancel_requested_at IS NOT NULL
                       OR EXISTS (
                            SELECT 1
                              FROM provider_operations AS operation
                             WHERE operation.distribution_id = distribution.id
                          )) AS provider_owned
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
            // Split targets by what their existing row permits: pending rows
            // are edited in place, absent rows created, and settled rows left
            // untouched and unvalidated. A locally cancelled row revives only
            // while no provider attempt, ledger entry, published copy, or
            // requested cancellation owns it, because `(post_id,
            // platform_account_id)` is unique and the intent must not succeed
            // while publishing nothing.
            const actionable: {
              distributionId: string | null;
              selection: readonly string[];
              target: PostTargetInput;
            }[] = [];
            for (const target of targets) {
              const current = byAccount.get(target.platformAccountId);
              if (
                current !== undefined &&
                !EDITABLE_DISTRIBUTION_STATUSES.has(current.status) &&
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
            // Only actionable targets contribute work, so only their Channels
            // and selected media are read.
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
              const platform = yield* validateTargetScheduleEffect(
                post,
                entry.target,
                entry.selection,
                account,
                account?.platform ? capabilities.get(account.platform) : undefined,
                candidates,
                now,
              );
              const row: ResolvedTargetRow = {
                platform,
                platformAccountId: entry.target.platformAccountId,
                target: entry.target,
              };
              if (entry.distributionId === null) {
                created.push(row);
              } else {
                pending.push({ ...row, distributionId: entry.distributionId });
              }
            }
            if (created.length > 0) {
              yield* usageGuardEffect(client, organizationId, created.length);
            }
            const scheduled =
              input.scheduledAt !== null && input.scheduledAt.getTime() > now.getTime();
            const status = scheduled ? ("scheduled" as const) : ("queued" as const);
            const scheduledAt = input.scheduledAt?.toISOString() ?? null;
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
              scheduledAt: scheduled ? input.scheduledAt : null,
            };
            yield* insertOutboxBatchEffect(client, organizationId, createdIds, command);
            if (rescheduledIds.length > 0) {
              // A reschedule replaces the previous delivery intent: stale
              // commands would otherwise publish at the abandoned instant.
              yield* client.query(
                `DELETE FROM outbox_events
                  WHERE aggregate_id = ANY($1::uuid[])
                    AND topic = 'distribution.publish.requested'
                    AND state IN ('pending', 'failed')`,
                [rescheduledIds],
              );
              yield* insertOutboxBatchEffect(client, organizationId, rescheduledIds, command);
            }
            const requested = new Set(targets.map((target) => target.platformAccountId));
            const dropped = existing.rows.filter(
              (row) =>
                row.platform_account_id !== null &&
                !requested.has(row.platform_account_id) &&
                EDITABLE_DISTRIBUTION_STATUSES.has(row.status),
            );
            if (dropped.length > 0) {
              const droppedIds = dropped.map((row) => row.id);
              // As in Post deletion, derive command cleanup from the cancelled
              // rows in one statement; leased commands remain consumer-owned.
              yield* client.query(
                `WITH cancelled AS (
                   UPDATE distributions
                      SET status = 'cancelled', updated_at = now()
                    WHERE id = ANY($1::uuid[])
                    RETURNING id
                 )
                 DELETE FROM outbox_events
                  WHERE aggregate_id IN (SELECT id FROM cancelled)
                    AND topic = 'distribution.publish.requested'
                    AND state IN ('pending', 'failed')`,
                [droppedIds],
              );
            }
            // Saving the effective targets again is only meaningful when the
            // request supplied them; scheduling the already-saved set leaves the
            // stored settings untouched, so the rewrite is skipped rather than
            // issuing two statements that reproduce identical rows.
            if (input.targets) {
              yield* replaceTargetsEffect(client, post, targets);
            }
            const updated = yield* updatePostRowEffect(client, postId, {
              activate: true,
            });
            const value = yield* assembleSinglePostEffect(client, updated, {
              ...(preloadAttachments ? { attachments: preloadAttachments } : {}),
              ...(preloadTargets ? { targets: preloadTargets } : {}),
            });
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "schedule-post",
              idempotencyKey,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },

    deletePost(
      env: ApiWorkerEnv,
      session: SessionClaims,
      postId: string,
      input: DeletePostInput,
      idempotencyKey: string,
    ) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({ brandProfileId: input.brandProfileId, postId }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "delete-post",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Post,
              };
            }
            // Deletion only releases retention and cancels pending work; it
            // never charges quota. Locking the Workspace here would serialize
            // every deletion in one tenant behind a single lock row without
            // protecting anything deletion writes.
            const post = yield* lockPostEffect(client, postId);
            // Deleting is scoped like every other Post mutation: the request must
            // name the Brand Profile that owns the Post, so an aggregate-view
            // caller with no identity selected cannot destroy one.
            yield* Effect.try({
              try: () => requireMatchingBrandProfile(post, input.brandProfileId),
              catch: validationError,
            });
            yield* requireActiveBrandProfileEffect(client, organizationId, post.brand_profile_id);
            // Published history is administratively owned: Editors may delete
            // drafts and scheduled Posts (their pending work is cancelled), but
            // removing a Post that reached or is attempting a Platform is an
            // Admin action.
            if (session.organizationRole !== "admin") {
              const published = yield* client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM distributions
                   WHERE post_id = $1
                     AND status IN (
                       'processing', 'awaiting_provider', 'published', 'needs_reconciliation'
                     )
                 ) AS exists`,
                [postId],
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
            // Both collection statements above ran in this transaction, so
            // their authoritative result is empty. Re-reading them in the
            // response projection would repeat work the delete already did.
            const value = yield* assembleSinglePostEffect(client, deleted.rows[0]!, {
              attachments: new Map<string, Schemas["PostAttachment"][]>([[postId, []]]),
              targets: new Map<string, Schemas["PostTarget"][]>([[postId, []]]),
            });
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "delete-post",
              idempotencyKey,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },
  };
}
