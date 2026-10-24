import { Effect } from "effect";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { systemPoolFor } from "../src/database";
import { enqueueDueDistributions, processDistributionMessage } from "../src/distribution";
import { distributionProcessingGraceSeconds } from "../src/due-work";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { providerMediaRetrievalLeaseSeconds } from "../src/provider-media";
import { runSystemTransaction } from "./system-transaction";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

// The seeded Alpha workspace owns the connected YouTube Channel these
// publication fixtures use; brand_profile_id is mandatory and the composite
// foreign keys require same-profile references throughout.
const organizationId = "20000000-0000-4000-8000-000000000001";
const seededAlphaProfileId = "a0000000-0000-4000-8000-000000000001";
const seededChannelId = "50000000-0000-4000-8000-000000000001";

const postId = "9a000000-0000-4000-8000-000000000001";
const secondPostId = "9a000000-0000-4000-8000-000000000002";
const firstAssetId = "9b000000-0000-4000-8000-000000000001";
const secondAssetId = "9b000000-0000-4000-8000-000000000002";
const firstObjectId = "9c000000-0000-4000-8000-000000000001";
const firstRenditionObjectId = "9c000000-0000-4000-8000-000000000002";
const firstRenditionId = "9d000000-0000-4000-8000-000000000001";
const firstOriginalRenditionId = "9d000000-0000-4000-8000-000000000003";
const secondObjectId = "9c000000-0000-4000-8000-000000000003";
const secondRenditionObjectId = "9c000000-0000-4000-8000-000000000004";
const secondRenditionId = "9d000000-0000-4000-8000-000000000002";
const secondOriginalRenditionId = "9d000000-0000-4000-8000-000000000004";

const firstObjectKey = `${organizationId}/${firstAssetId}/original`;
const firstRenditionKey = `${organizationId}/${firstAssetId}/rendition-webp`;
const secondObjectKey = `${organizationId}/${secondAssetId}/original`;
const secondRenditionKey = `${organizationId}/${secondAssetId}/rendition-webp`;

// Capability-driven selection needs a Platform whose accepted media types
// exclude the smallest ready object: Instagram takes JPEG and PNG, never the
// WEBP rendition the image profile produces. `mixedAssetId` holds an approved
// JPEG original behind a ready reference beside that smaller WEBP, so only the
// original is deliverable; `jpegAssetId` holds an unreferenced JPEG original
// beside an approved JPEG rendition, so only the rendition is deliverable. One
// publication over both resolves one attachment to a verified original and the
// next to an optimization output.
const mixedAssetId = "9b000000-0000-4000-8000-000000000003";
const mixedWebpObjectId = "9c000000-0000-4000-8000-000000000005";
const mixedJpegObjectId = "9c000000-0000-4000-8000-000000000006";
const mixedWebpRenditionId = "9d000000-0000-4000-8000-000000000005";
const mixedOriginalRenditionId = "9d000000-0000-4000-8000-000000000006";
const mixedWebpKey = `${organizationId}/${mixedAssetId}/rendition-webp`;
const mixedJpegKey = `${organizationId}/${mixedAssetId}/original`;
const jpegAssetId = "9b000000-0000-4000-8000-000000000007";
const jpegOriginalObjectId = "9c000000-0000-4000-8000-000000000008";
const jpegRenditionObjectId = "9c000000-0000-4000-8000-000000000009";
const jpegRenditionId = "9d000000-0000-4000-8000-000000000008";
const jpegOriginalKey = `${organizationId}/${jpegAssetId}/original`;
const jpegRenditionKey = `${organizationId}/${jpegAssetId}/rendition-jpeg`;

// An Asset in a lifecycle state processing has not approved can still hold a
// ready object behind a ready rendition reference. Each state below must keep
// that object out of a publication. Only attachable non-ready states appear:
// the attachment trigger rejects 'deleting'/'deleted' media outright and the
// delete-claim guard bars an attached Asset from entering them, so a
// 'deleting' attachment cannot exist in a Post to be claimed.
const unapprovedAssets = [
  {
    assetId: "9b000000-0000-4000-8000-000000000004",
    objectId: "9c000000-0000-4000-8000-00000000000a",
    objectKey: `${organizationId}/9b000000-0000-4000-8000-000000000004/original`,
    renditionId: "9d000000-0000-4000-8000-000000000009",
    status: "processing",
  },
  {
    assetId: "9b000000-0000-4000-8000-000000000005",
    objectId: "9c000000-0000-4000-8000-00000000000b",
    objectKey: `${organizationId}/9b000000-0000-4000-8000-000000000005/original`,
    renditionId: "9d000000-0000-4000-8000-00000000000a",
    status: "failed",
  },
] as const;

const youtubeDistributionId = "9e000000-0000-4000-8000-000000000001";
const partialDistributionId = "9e000000-0000-4000-8000-000000000002";
const rejectedDistributionId = "9e000000-0000-4000-8000-000000000005";
const leaseRecoveryDistributionId = "9e000000-0000-4000-8000-000000000003";
const textOnlyPostId = "9a000000-0000-4000-8000-000000000003";
const textOnlyDistributionId = "9e000000-0000-4000-8000-000000000004";
const mixedPostId = "9a000000-0000-4000-8000-000000000004";
const mixedDistributionId = "9e000000-0000-4000-8000-000000000006";
const unapprovedPostId = "9a000000-0000-4000-8000-000000000005";
const unapprovedDistributionId = "9e000000-0000-4000-8000-000000000007";
const instagramAccountId = "50000000-0000-4000-8000-000000000002";
// One Distribution per (Post, Channel): distributions_post_platform_account_unique
// enforces it, so the partial-selection target and the rejected sibling target
// in the same Post use distinct Providers. The canonical seeded YouTube account
// owns the Post's YouTube target, leaving Threads for the partial target and
// Facebook for the rejection.
const partialChannelId = "50000000-0000-4000-8000-000000000003";
const rejectedChannelId = "50000000-0000-4000-8000-000000000004";
const distributionIds = [
  youtubeDistributionId,
  partialDistributionId,
  leaseRecoveryDistributionId,
  textOnlyDistributionId,
  rejectedDistributionId,
  mixedDistributionId,
  unapprovedDistributionId,
];
const postIds = [postId, secondPostId, textOnlyPostId, mixedPostId, unapprovedPostId];
const assetIds = [
  firstAssetId,
  secondAssetId,
  mixedAssetId,
  jpegAssetId,
  ...unapprovedAssets.map((asset) => asset.assetId),
];
const eventIds = [
  "distribution-integration-publish",
  "distribution-integration-partial",
  "distribution-integration-lease",
  "distribution-integration-text-only",
  "distribution-integration-partial-rejected",
  "distribution-integration-mixed",
  "distribution-integration-unapproved",
];

const env = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies AutomationEnv;

/**
 * Registers a publish-capable YouTube adapter that accepts one ordered media
 * item, so these fixtures exercise the real registry/capability checks rather
 * than a stubbed publish call.
 */
function youtubeRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      accepted_mime_types: ["image/webp", "video/mp4"],
      analytics: false,
      asset_types: ["image", "video"],
      connect_available: false,
      max_caption_length: 5000,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 15,
      max_media_count: 1,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: [],
      platform: "youtube",
      publish: true,
      reply: false,
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish,
    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: ["remote_ingest"],
  } as unknown as ProviderAdapter);
  return registry;
}

/**
 * Registers a publish-capable Instagram adapter mirroring the production
 * capability: JPEG and PNG stills only, so a ready WEBP rendition is
 * undeliverable and only an approved JPEG object can be frozen for it. The
 * capability is real — the claim reads it through the registry, so a selection
 * that ignored it would freeze the WEBP and fail.
 */
function instagramRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("instagram", {
    capability: {
      accepted_mime_types: ["image/jpeg", "image/png", "video/mp4"],
      analytics: false,
      asset_types: ["image", "video"],
      connect_available: false,
      max_caption_length: 2_200,
      max_file_size: 8 * 1024 * 1024,
      max_hashtags: 30,
      max_media_count: 10,
      max_video_duration_sec: 900,
      min_media_count: 1,
      multi_asset_types: ["image", "video"],
      notes: [],
      platform: "instagram",
      publish: true,
      reply: false,
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish,
    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: ["remote_ingest"],
  } as unknown as ProviderAdapter);
  return registry;
}

/**
 * Registers a publish-capable Threads adapter mirroring the production
 * capability's stills support, so a frozen media object can reach the Provider
 * and only the Provider's own answer can reject it.
 */
function threadsRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("threads", {
    capability: {
      accepted_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
      analytics: false,
      asset_types: ["image", "video"],
      connect_available: false,
      max_caption_length: 500,
      max_file_size: 8 * 1024 * 1024,
      max_hashtags: 1,
      max_media_count: 20,
      max_video_duration_sec: 300,
      min_media_count: 0,
      multi_asset_types: ["image", "video"],
      notes: [],
      platform: "threads",
      publish: true,
      reply: false,
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish,
    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: ["remote_ingest"],
  } as unknown as ProviderAdapter);
  return registry;
}

/**
 * Registers a publish-capable Facebook adapter for the rejection fixture: it
 * accepts the frozen stills shape so the Provider call is the failure point.
 */
function facebookRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("facebook", {
    capability: {
      accepted_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
      analytics: false,
      asset_types: ["image", "video"],
      connect_available: false,
      max_caption_length: 63_206,
      max_file_size: 500 * 1024 * 1024,
      max_hashtags: 30,
      max_media_count: 10,
      max_video_duration_sec: 60,
      min_media_count: 0,
      multi_asset_types: [],
      notes: [],
      platform: "facebook",
      publish: true,
      reply: false,
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish,
    retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
    transferModes: ["remote_ingest"],
  } as unknown as ProviderAdapter);
  return registry;
}

/**
 * The external bytes each seeded object stands for, keyed by object key.
 *
 * The resolver hands the Provider a real remote-ingest descriptor for the
 * frozen object rather than echoing the snapshot back, so an assertion on the
 * published media proves which stored object was selected rather than what the
 * fixture already recorded. An object with no entry here is a real failure:
 * the resolver throws instead of inventing a delivery.
 */
const storedBytes: Record<string, { bytes: number; mediaType: string }> = {
  [firstObjectKey]: { bytes: 4096, mediaType: "image/webp" },
  [firstRenditionKey]: { bytes: 2048, mediaType: "image/webp" },
  [secondObjectKey]: { bytes: 8192, mediaType: "image/webp" },
  [secondRenditionKey]: { bytes: 3072, mediaType: "image/webp" },
  [mixedWebpKey]: { bytes: 1024, mediaType: "image/webp" },
  [mixedJpegKey]: { bytes: 4096, mediaType: "image/jpeg" },
  [jpegOriginalKey]: { bytes: 2048, mediaType: "image/jpeg" },
  [jpegRenditionKey]: { bytes: 3072, mediaType: "image/jpeg" },
};

/**
 * Resolves external delivery bytes for a frozen object from the stored-byte
 * fixture, so the descriptor the Provider receives is derived from the object
 * that was actually selected.
 */
function byteResolver() {
  return vi.fn(async (request: { contentType: string; fileSize: number; objectKey: string }) => {
    const stored = storedBytes[request.objectKey];
    if (!stored) {
      throw new Error(`no external bytes are stored for ${request.objectKey}`);
    }
    return {
      contentType: stored.mediaType,
      fileSize: stored.bytes,
      mode: "remote_ingest" as const,
      url: `https://media.example/${encodeURIComponent(request.objectKey)}`,
    };
  });
}

/** Signs a remote-ingest URL for the object the snapshot froze. */
function mediaResolver() {
  return vi.fn(async (request: { contentType: string; fileSize: number; objectKey: string }) => ({
    contentType: request.contentType,
    fileSize: request.fileSize,
    mode: "remote_ingest" as const,
    url: `https://media.example/${encodeURIComponent(request.objectKey)}`,
  }));
}

function publishMessage(eventId: string, distributionId: string): OutboxMessage {
  return {
    aggregate_id: distributionId,
    event_id: eventId,
    organization_id: organizationId,
    payload: { distribution_id: distributionId, version: 1 },
    topic: "distribution.publish.requested",
    type: "outbox.event",
    version: 1,
  };
}

interface PublicationSnapshotRow extends Record<string, unknown> {
  publication_snapshot: {
    content: { hashtags: string[]; text: string; title: string };
    media: Array<{
      asset_id: string;
      object_key: string;
      position: number;
    }>;
    post_id: string;
  } | null;
}

interface HoldRow extends Record<string, unknown> {
  asset_id: string;
  media_hold_until: Date | null;
  object_key: string;
  operation: string;
  position: number;
}

async function publishSnapshot(distributionId: string) {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<PublicationSnapshotRow>(
      `SELECT publication_snapshot
       FROM provider_operations
       WHERE distribution_id = $1 AND operation = 'publish'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [distributionId],
    );
    return result.rows[0]?.publication_snapshot;
  });
}

async function mediaHolds(distributionId: string): Promise<HoldRow[]> {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<HoldRow>(
      `SELECT operation.operation, media.asset_id::text,
              media.object_key, media.position, operation.media_hold_until
       FROM provider_operation_media AS media
       JOIN provider_operations AS operation ON operation.id = media.operation_id
       WHERE media.distribution_id = $1
       ORDER BY media.position, operation.operation`,
      [distributionId],
    );
    return result.rows;
  });
}

/**
 * Creates the Posts, their saved per-Channel targets, ordered attachments,
 * ready media objects, and pending Distributions these suites publish through.
 *
 * Every candidate object is reachable only through a ready `asset_renditions`
 * reference, because that reference is what records a decode approving the
 * object for publication. Each YouTube Asset carries both its verified original
 * and a smaller ready rendition, so claim-time selection is observable; the
 * Instagram fixtures add the states selection has to get right — an approved
 * original beside an incompatible rendition, an unreferenced original beside an
 * approved rendition, and ready bytes on an Asset processing never approved.
 * Targets reference real, profile-owned Channels, including the separate
 * Instagram account. Seed foreign keys in order and keep one Distribution per
 * (Post, Channel) pair, as required by the unique ownership contract.
 */
async function seedCompositionFixtures(): Promise<void> {
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
      distributionIds,
    ]);
    await client.query(
      "DELETE FROM async_job_events WHERE event_key LIKE 'outbox:distribution-integration-%'",
    );
    await client.query(
      "DELETE FROM provider_operation_media WHERE distribution_id = ANY($1::uuid[])",
      [distributionIds],
    );
    await client.query("DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])", [
      distributionIds,
    ]);
    await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [distributionIds]);
    await client.query(
      `DELETE FROM platform_accounts
       WHERE id = ANY($1::uuid[])
         AND platform_user_id LIKE 'local-distribution-integration-%'`,
      [[instagramAccountId, partialChannelId, rejectedChannelId]],
    );
    await client.query("DELETE FROM post_attachments WHERE post_id = ANY($1::uuid[])", [postIds]);
    await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
    await client.query("DELETE FROM asset_renditions WHERE asset_id = ANY($1::uuid[])", [assetIds]);
    await client.query("DELETE FROM asset_objects WHERE asset_id = ANY($1::uuid[])", [assetIds]);
    await client.query("DELETE FROM assets WHERE id = ANY($1::uuid[])", [assetIds]);
    await client.query(
      `INSERT INTO assets
         (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
          file_size, mime_type, width, height, status, original_filename,
          finalized_at)
       VALUES
         ($1, $2, $3, NULL, 'image', 'Integration first', 4096, 'image/webp',
          1080, 1080, 'ready', 'first.png', now() - INTERVAL '2 days'),
         ($4, $2, $3, NULL, 'image', 'Integration second', 8192, 'image/webp',
          1200, 1200, 'ready', 'second.png', now() - INTERVAL '2 days'),
         ($5, $2, $3, NULL, 'image', 'Integration mixed', 9999, 'image/png',
          100, 100, 'ready', 'mixed.png', now() - INTERVAL '2 days'),
         ($6, $2, $3, NULL, 'image', 'Integration jpeg', 2048, 'image/png',
          640, 640, 'ready', 'jpeg.png', now() - INTERVAL '2 days'),
         ($7, $2, $3, NULL, 'image', 'Unapproved processing', 2048,
          'image/jpeg', 640, 640, 'processing', 'processing.jpg',
          now() - INTERVAL '2 days'),
         ($8, $2, $3, NULL, 'image', 'Unapproved failed', 2048, 'image/jpeg',
          640, 640, 'failed', 'failed.jpg', now() - INTERVAL '2 days')`,
      [
        firstAssetId,
        organizationId,
        seededAlphaProfileId,
        secondAssetId,
        mixedAssetId,
        jpegAssetId,
        unapprovedAssets[0].assetId,
        unapprovedAssets[1].assetId,
      ],
    );
    await client.query(
      `INSERT INTO asset_objects
         (id, org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
          etag, content_type, width, height, status)
       VALUES
         ($1, $4, $6, $8, 'original', 'original', $9, 4096, 'etag-original-1',
          'image/webp', 1080, 1080, 'ready'),
         ($2, $4, $6, $8, 'rendition', 'image_webp_1080_long_edge', $10, 2048,
          'etag-rendition-1', 'image/webp', 1080, 1080, 'ready'),
         ($3, $4, $7, $8, 'original', 'original', $11, 8192, 'etag-original-2',
          'image/webp', 1200, 1200, 'ready'),
         ($5, $4, $7, $8, 'rendition', 'image_webp_1080_long_edge', $12, 3072,
          'etag-rendition-2', 'image/webp', 1200, 1200, 'ready'),
         -- The mixed Asset's stored media type and size are deliberately
         -- coarser than its objects: the verified JPEG original carries the
         -- facts a publishable candidate must use.
         ($13, $4, $14, $8, 'rendition', 'image_webp_1080_long_edge', $15,
          1024, 'etag-mixed-webp', 'image/webp', 2048, 2048, 'ready'),
         ($16, $4, $14, $8, 'original', 'original', $17, 4096,
          'etag-mixed-jpeg', 'image/jpeg', 2048, 2048, 'ready'),
         ($18, $4, $19, $8, 'original', 'original', $20, 2048,
          'etag-jpeg-original', 'image/jpeg', 640, 640, 'ready'),
         ($21, $4, $19, $8, 'rendition', 'image_jpeg_1080_long_edge', $22,
          3072, 'etag-jpeg-rendition', 'image/jpeg', 640, 640, 'ready')`,
      [
        firstObjectId,
        firstRenditionObjectId,
        secondObjectId,
        organizationId,
        secondRenditionObjectId,
        firstAssetId,
        secondAssetId,
        seededAlphaProfileId,
        firstObjectKey,
        firstRenditionKey,
        secondObjectKey,
        secondRenditionKey,
        mixedWebpObjectId,
        mixedAssetId,
        mixedWebpKey,
        mixedJpegObjectId,
        mixedJpegKey,
        jpegOriginalObjectId,
        jpegAssetId,
        jpegOriginalKey,
        jpegRenditionObjectId,
        jpegRenditionKey,
      ],
    );
    // The unapproved Assets keep a ready object behind a ready rendition
    // reference: only the Asset's own lifecycle state separates those bytes
    // from media processing never approved for publication.
    for (const { assetId, objectId, objectKey, status } of unapprovedAssets) {
      await client.query(
        `INSERT INTO asset_objects
           (id, org_id, asset_id, brand_profile_id, kind, profile, r2_key,
            bytes, etag, content_type, width, height, status)
         VALUES ($1, $2, $3, $4, 'original', 'original', $5, 2048, $6,
                 'image/jpeg', 640, 640, 'ready')`,
        [objectId, organizationId, assetId, seededAlphaProfileId, objectKey, `etag-${status}`],
      );
    }
    await client.query(
      `INSERT INTO asset_renditions
         (id, org_id, asset_id, brand_profile_id, profile, object_id, status)
       VALUES
         ($1, $8, $9, $10, 'image_webp_1080_long_edge', $11, 'ready'),
         ($2, $8, $9, $10, 'original', $12, 'ready'),
         ($3, $8, $13, $10, 'image_webp_1080_long_edge', $14, 'ready'),
         ($4, $8, $13, $10, 'original', $15, 'ready'),
         ($5, $8, $16, $10, 'image_webp_1080_long_edge', $17, 'ready'),
         ($6, $8, $16, $10, 'image_jpeg_1080_long_edge', $18, 'ready'),
         ($7, $8, $19, $10, 'image_jpeg_1080_long_edge', $20, 'ready')`,
      [
        firstRenditionId,
        firstOriginalRenditionId,
        secondRenditionId,
        secondOriginalRenditionId,
        mixedWebpRenditionId,
        mixedOriginalRenditionId,
        jpegRenditionId,
        organizationId,
        firstAssetId,
        seededAlphaProfileId,
        firstRenditionObjectId,
        firstObjectId,
        secondAssetId,
        secondRenditionObjectId,
        secondObjectId,
        mixedAssetId,
        mixedWebpObjectId,
        mixedJpegObjectId,
        jpegAssetId,
        jpegRenditionObjectId,
      ],
    );
    for (const { assetId, objectId, renditionId } of unapprovedAssets) {
      await client.query(
        `INSERT INTO asset_renditions
           (id, org_id, asset_id, brand_profile_id, profile, object_id,
            status)
         VALUES ($1, $2, $3, $4, 'original', $5, 'ready')`,
        [renditionId, organizationId, assetId, seededAlphaProfileId, objectId],
      );
    }
    await client.query(
      `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
       VALUES
         ($1, $4, $5, 'Integration launch', 'First caption', 'active'),
         ($2, $4, $5, 'Second launch', 'Second caption', 'active'),
         ($3, $4, $5, 'Notes only', 'Text-only caption', 'active'),
         ($6, $4, $5, 'Mixed launch', 'Mixed caption', 'active'),
         ($7, $4, $5, 'Unapproved launch', 'Unapproved caption', 'active')`,
      [
        postId,
        secondPostId,
        textOnlyPostId,
        organizationId,
        seededAlphaProfileId,
        mixedPostId,
        unapprovedPostId,
      ],
    );
    // The two sibling targets of `postId` need their own connected Channels: a
    // Brand Profile owns at most one Channel per Provider, so the siblings
    // differ by Platform, and one Distribution per (Post, Channel) is a
    // database constraint anyway.
    await client.query(
      `INSERT INTO platform_accounts
         (id, org_id, brand_profile_id, platform, platform_user_id,
          display_name, access_token, scopes, connection_status)
       VALUES ($1, $2, $3, 'threads', 'local-distribution-integration-partial',
               'Alpha Channel (partial)', 'local-only-not-a-provider-credential',
               ARRAY['threads_basic'], 'connected'),
              ($4, $2, $3, 'facebook', 'local-distribution-integration-rejected',
               'Alpha Channel (rejected)', 'local-only-not-a-provider-credential',
               ARRAY['facebook_basic'], 'connected'),
              -- Instagram owns its own connected Channel because its
              -- capability is what makes the smaller WEBP rendition
              -- undeliverable for these Assets.
              ($5, $2, $3, 'instagram', 'local-distribution-integration-instagram',
               'Alpha Studio IG', 'local-only-not-a-provider-credential',
               ARRAY['instagram_basic'], 'connected')`,
      [
        partialChannelId,
        organizationId,
        seededAlphaProfileId,
        rejectedChannelId,
        instagramAccountId,
      ],
    );
    // Every Channel a Distribution publishes through carries its saved target
    // settings. The claim reads the resolved copy on the Distribution row, so
    // these mirror what that row froze: a selection for the partial target, an
    // empty array for the deliberate text-only target, and NULL where the
    // target inherits the Post's own attachment order.
    await client.query(
      `INSERT INTO post_targets
         (post_id, platform_account_id, org_id, brand_profile_id,
          attachment_ids)
       VALUES ($1, $2, $3, $4, NULL),
              ($1, $5, $3, $4, ARRAY[$6]::uuid[]),
              ($1, $7, $3, $4, ARRAY[$6]::uuid[]),
              ($8, $2, $3, $4, NULL),
              ($9, $2, $3, $4, ARRAY[]::uuid[]),
              ($10, $12, $3, $4, NULL),
              ($11, $12, $3, $4, NULL)`,
      [
        postId,
        seededChannelId,
        organizationId,
        seededAlphaProfileId,
        partialChannelId,
        secondAssetId,
        rejectedChannelId,
        secondPostId,
        textOnlyPostId,
        mixedPostId,
        unapprovedPostId,
        instagramAccountId,
      ],
    );
    await client.query(
      `INSERT INTO post_attachments
         (post_id, asset_id, org_id, brand_profile_id, position)
       VALUES ($1, $3, $4, $5, 0), ($1, $6, $4, $5, 1), ($2, $6, $4, $5, 0),
              ($7, $8, $4, $5, 0), ($7, $9, $4, $5, 1),
              ($10, $11, $4, $5, 0), ($10, $12, $4, $5, 1)`,
      [
        postId,
        secondPostId,
        firstAssetId,
        organizationId,
        seededAlphaProfileId,
        secondAssetId,
        mixedPostId,
        mixedAssetId,
        jpegAssetId,
        unapprovedPostId,
        unapprovedAssets[0].assetId,
        unapprovedAssets[1].assetId,
      ],
    );
    // The stalled-publish fixture targets its own Post, so it holds a distinct
    // (Post, Channel) pair rather than colliding with the queued publish.
    await client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, attachment_ids)
       VALUES ($1, $5, $6, $7, $8, 'youtube', 'queued', NULL),
              ($2, $5, $6, $7, $9, 'threads', 'queued', ARRAY[$10]::uuid[]),
              ($3, $5, $6, $11, $8, 'youtube', 'processing', NULL),
              ($4, $5, $6, $12, $8, 'youtube', 'queued', ARRAY[]::uuid[])`,
      [
        youtubeDistributionId,
        partialDistributionId,
        leaseRecoveryDistributionId,
        textOnlyDistributionId,
        organizationId,
        seededAlphaProfileId,
        postId,
        seededChannelId,
        partialChannelId,
        secondAssetId,
        secondPostId,
        textOnlyPostId,
      ],
    );
    await client.query(
      `INSERT INTO distributions
         (id, org_id, brand_profile_id, post_id, platform_account_id, platform,
          status, attachment_ids)
       VALUES ($1, $3, $4, $5, $6, 'instagram', 'queued', NULL),
              ($2, $3, $4, $7, $6, 'instagram', 'queued', NULL)`,
      [
        mixedDistributionId,
        unapprovedDistributionId,
        organizationId,
        seededAlphaProfileId,
        mixedPostId,
        instagramAccountId,
        unapprovedPostId,
      ],
    );
  });
}

/**
 * Returns every Distribution these suites mutate to its pre-attempt state.
 *
 * Two durable records make a repeated attempt impossible, so both are cleared
 * with the row: the publish intent is keyed by `(distribution, operation,
 * event id)`, and the job lease is keyed by event id alone and is only
 * re-claimable after a failure. Each test therefore starts from the state a
 * workspace that had never published would be in. The stalled-publish row is
 * deliberately left in its seeded `processing` state, because that in-flight
 * attempt is what the reconciliation specs depend on.
 */
async function resetCompositions(): Promise<void> {
  await runSystemTransaction(env, async (client) => {
    await client.query(
      "DELETE FROM provider_operation_media WHERE distribution_id = ANY($1::uuid[])",
      [distributionIds],
    );
    await client.query("DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])", [
      distributionIds,
    ]);
    await client.query(
      "DELETE FROM async_job_events WHERE event_key LIKE 'outbox:distribution-integration-%'",
    );
    await client.query(
      `UPDATE posts
       SET title = 'Integration launch', default_text = 'First caption'
       WHERE id IN ($1, $2)`,
      [postId, secondPostId],
    );
    // The whole attachment set is cleared rather than one position: the
    // composition specs detach and re-add attachments themselves, so restoring
    // only the trailing position would collide with an attachment left at
    // position 0.
    await client.query(`DELETE FROM post_attachments WHERE post_id = $1`, [postId]);
    await client.query(
      `INSERT INTO post_attachments
         (post_id, asset_id, org_id, brand_profile_id, position)
       VALUES ($1, $2, $3, $4, 0), ($1, $5, $3, $4, 1)`,
      [postId, firstAssetId, organizationId, seededAlphaProfileId, secondAssetId],
    );
    // Only the never-attempted rows are reset. The stalled publish row keeps
    // its `processing` status: a second publish trigger on it must keep
    // no-oping so reconciliation, not a duplicate upload, owns its outcome.
    await client.query(
      `UPDATE distributions
       SET status = 'queued', attempt_count = 0, reconciliation_attempt_count = 0,
           provider_operation_id = NULL, platform_post_id = NULL,
           platform_url = NULL, published_at = NULL, next_attempt_at = NULL,
           failure_code = NULL, failure_retryable = NULL, error_message = NULL,
           attachment_ids = CASE WHEN id = $2 THEN ARRAY[$3]::uuid[] ELSE NULL END,
           updated_at = now()
       WHERE id IN ($1, $2)`,
      [youtubeDistributionId, partialDistributionId, secondAssetId],
    );
    await client.query(
      `UPDATE distributions
       SET status = 'queued', attempt_count = 0, reconciliation_attempt_count = 0,
           provider_operation_id = NULL, platform_post_id = NULL,
           platform_url = NULL, published_at = NULL, next_attempt_at = NULL,
           failure_code = NULL, failure_retryable = NULL, error_message = NULL,
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [[textOnlyDistributionId, mixedDistributionId, unapprovedDistributionId]],
    );
  });
}

describeIntegration("Distribution publication with PostgreSQL", () => {
  beforeAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE organizations
         SET plan = 'creator', billing_status = 'active', updated_at = now()
         WHERE id = $1`,
        [organizationId],
      );
    });
    await seedCompositionFixtures();
  });

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query(
        "DELETE FROM provider_operation_media WHERE distribution_id = ANY($1::uuid[])",
        [distributionIds],
      );
      await client.query(
        "DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])",
        [distributionIds],
      );
      await client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
        distributionIds,
      ]);
      await client.query(
        "DELETE FROM async_job_events WHERE event_key LIKE 'outbox:distribution-integration-%'",
      );
      await client.query("DELETE FROM post_attachments WHERE post_id = ANY($1::uuid[])", [postIds]);
      await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
      // Saved targets cascade from their Post and their Channel, so clearing
      // the fixture Posts and the fixture-owned Channels clears them too.
      await client.query(
        `DELETE FROM platform_accounts
         WHERE id = ANY($1::uuid[])
           AND platform_user_id LIKE 'local-distribution-integration-%'`,
        [[instagramAccountId, partialChannelId, rejectedChannelId]],
      );
      await client.query("DELETE FROM asset_renditions WHERE asset_id = ANY($1::uuid[])", [
        assetIds,
      ]);
      await client.query("DELETE FROM asset_objects WHERE asset_id = ANY($1::uuid[])", [assetIds]);
      await client.query("DELETE FROM assets WHERE id = ANY($1::uuid[])", [assetIds]);
      await client.query("DELETE FROM rate_limit_budgets");
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'local-only-not-a-provider-credential',
             refresh_token = NULL, token_expires_at = NULL,
             connection_status = 'connected', updated_at = now()
         WHERE id = $1`,
        [seededChannelId],
      );
    });
    await systemPoolFor(env).end();
  });

  it("refuses a multi-attachment Post on a single-file Platform before delivery", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-1",
    }));
    const mediaFor = mediaResolver();

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[0]!, youtubeDistributionId), {
          decryptToken: async (stored) => `decrypted:${stored}`,
          mediaFor,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");

    // One Post with two ordered attachments exceeds the Channel's media count,
    // so nothing is delivered and the Provider is never called.
    expect(mediaFor).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const outcome = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string;
        status: string;
      }>("SELECT status, failure_code FROM distributions WHERE id = $1", [youtubeDistributionId]);
      return result.rows[0];
    });
    expect(outcome).toMatchObject({
      failure_code: "provider_media_count_limit",
      status: "failed",
    });
    // The composition is still frozen: a later retry or reconciliation must
    // see the same attachments this attempt resolved.
    expect((await publishSnapshot(youtubeDistributionId))?.media).toEqual([
      {
        asset_id: firstAssetId,
        asset_type: "image",
        content_type: "image/webp",
        duration_sec: null,
        etag: "etag-rendition-1",
        file_size: 2048,
        height: 1080,
        object_id: firstRenditionObjectId,
        object_key: firstRenditionKey,
        position: 0,
        rendition_id: firstRenditionId,
        width: 1080,
      },
      {
        asset_id: secondAssetId,
        asset_type: "image",
        content_type: "image/webp",
        duration_sec: null,
        etag: "etag-rendition-2",
        file_size: 3072,
        height: 1200,
        object_id: secondRenditionObjectId,
        object_key: secondRenditionKey,
        position: 1,
        rendition_id: secondRenditionId,
        width: 1200,
      },
    ]);
    // Even a refused attempt holds its frozen objects for the retrieval
    // window: the cleanup sweep, not the outcome, releases them on expiry.
    expect(await mediaHolds(youtubeDistributionId)).toEqual([
      {
        asset_id: firstAssetId,
        media_hold_until: expect.any(Date),
        object_key: firstRenditionKey,
        operation: "publish",
        position: 0,
      },
      {
        asset_id: secondAssetId,
        media_hold_until: expect.any(Date),
        object_key: secondRenditionKey,
        operation: "publish",
        position: 1,
      },
    ]);
  });

  it("delivers the frozen rendition and keeps it held through the retrieval window", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-2",
      providerUrl: "https://provider.example/watch/2?access_token=must-not-persist",
    }));
    const mediaFor = mediaResolver();

    // Restrict this target to one attachment so the delivery path itself is
    // exercised end to end, independently of the count-rejection fixture above.
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET attachment_ids = ARRAY[$2]::uuid[]
         WHERE id = $1`,
        [youtubeDistributionId, firstAssetId],
      ),
    );

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[0]!, youtubeDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");
    expect(publish).toHaveBeenCalledOnce();
    // The smaller ready rendition is preferred over the verified original.
    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      objectKey: firstRenditionKey,
    });
    const [, , input] = publish.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { caption: string; media: Array<{ metadata?: unknown; url: string }> },
    ];
    expect(input.caption).toBe("Integration launch\n\nFirst caption");
    expect(input.media).toEqual([
      {
        contentType: "image/webp",
        fileSize: 2048,
        metadata: { height: 1080, width: 1080 },
        mode: "remote_ingest",
        url: `https://media.example/${encodeURIComponent(firstRenditionKey)}`,
      },
    ]);
    const frozen = await publishSnapshot(youtubeDistributionId);
    expect(frozen?.content).toMatchObject({
      text: "First caption",
      title: "Integration launch",
    });
    // The hold is not dropped on success: the Provider may still fetch the
    // handed-out URL for up to the retrieval window, so cleanup relies on
    // `media_hold_until` expiring rather than on the attempt's status.
    const held = await mediaHolds(youtubeDistributionId);
    expect(held).toEqual([
      {
        asset_id: firstAssetId,
        media_hold_until: expect.any(Date),
        object_key: firstRenditionKey,
        operation: "publish",
        position: 0,
      },
    ]);
    expect(held[0]!.media_hold_until!.getTime()).toBeGreaterThan(Date.now());

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE posts
         SET title = 'Rewritten title', default_text = 'Rewritten caption'
         WHERE id = $1`,
        [postId],
      );
      await client.query("DELETE FROM post_attachments WHERE post_id = $1 AND position = 1", [
        postId,
      ]);
    });

    expect(await publishSnapshot(youtubeDistributionId)).toEqual(frozen);
    await resetCompositions();
  });

  it("keeps a target's own attachment selection out of its sibling", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_failure" as const,
      failure: {
        classification: "deterministic" as const,
        code: "provider_reconnect_required",
        message: "Channel is not connected.",
        retryable: false,
        status: 401,
      },
    }));
    const mediaFor = mediaResolver();

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[1]!, partialDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: threadsRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");
    // Only the attachment this target selected is resolved and delivered; the
    // Post's other attachment never reaches the Channel.
    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      objectKey: secondRenditionKey,
    });
    expect(publish).toHaveBeenCalledOnce();
    const snapshot = await publishSnapshot(partialDistributionId);
    // The target selected one attachment; the Post's second attachment must
    // not appear in this attempt's frozen media.
    expect(snapshot?.media).toEqual([
      {
        asset_id: secondAssetId,
        asset_type: "image",
        content_type: "image/webp",
        duration_sec: null,
        etag: "etag-rendition-2",
        file_size: 3072,
        height: 1200,
        object_id: secondRenditionObjectId,
        object_key: secondRenditionKey,
        position: 1,
        rendition_id: secondRenditionId,
        width: 1200,
      },
    ]);
  });

  it("publishes a text-only Post with no media and no delivery", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-text",
    }));
    const mediaFor = mediaResolver();

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[3]!, textOnlyDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");
    expect(mediaFor).not.toHaveBeenCalled();
    const snapshot = await publishSnapshot(textOnlyDistributionId);
    expect(snapshot?.content.title).toBe("Notes only");
    expect(snapshot?.media).toEqual([]);
  });

  it("keeps one Post's channel outcomes independent after partial success", async () => {
    await resetCompositions();
    const succeeded = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-partial-success",
    }));
    const rejected = vi.fn(async () => ({
      outcome: "confirmed_failure" as const,
      failure: {
        classification: "deterministic" as const,
        code: "unsupported_media_type",
        message: "Channel does not accept image/webp.",
        retryable: false,
        status: 422,
      },
    }));

    // Two channels of the same Post: one accepts the attachment, one does not.
    // A failure on one target must leave the other target's success intact.
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[1]!, partialDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor: mediaResolver(),
          providerRegistry: threadsRegistry(succeeded),
        }),
      ),
    ).resolves.toBe("processed");
    // A second Channel of the same Post on a different Provider: a Brand
    // Profile owns at most one Channel per Provider, so the sibling differs by
    // Platform and holds its own saved target.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attachment_ids)
         VALUES ($1, $2, $3, $4, $5, 'facebook', 'queued', ARRAY[$6]::uuid[])`,
        [
          rejectedDistributionId,
          organizationId,
          seededAlphaProfileId,
          postId,
          rejectedChannelId,
          secondAssetId,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.publish.requested', 'distribution', $2,
                 $3, $4::jsonb)`,
        [
          organizationId,
          rejectedDistributionId,
          `distribution-integration-partial-rejected`,
          JSON.stringify({
            distribution_id: rejectedDistributionId,
            version: 1,
          }),
        ],
      );
    });
    // The rejected Channel receives bytes that are valid for its own frozen
    // object; it is the Platform that refuses them, so the refusal is the
    // provider's answer rather than a preparation error.
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[4]!, rejectedDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor: mediaResolver(),
          providerRegistry: facebookRegistry(rejected),
        }),
      ),
    ).resolves.toBe("processed");

    const outcomes = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string | null;
        post_id: string;
        status: string;
      }>(
        `SELECT post_id, status, failure_code
         FROM distributions
         WHERE id IN ($1, $2)
         ORDER BY id`,
        [partialDistributionId, rejectedDistributionId],
      );
      return result.rows;
    });
    expect(outcomes).toEqual([
      {
        failure_code: null,
        post_id: postId,
        status: "published",
      },
      {
        failure_code: "unsupported_media_type",
        post_id: postId,
        status: "failed",
      },
    ]);
    // Retrying the failed channel must not republish the successful one.
    expect(await publishSnapshot(rejectedDistributionId)).toMatchObject({
      post_id: postId,
    });
  });

  it("holds frozen media while a stalled attempt awaits reconciliation", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const eventId = eventIds[2]!;

    // An in-flight publish that was lost mid-attempt must not be republished,
    // and its media must stay held while reconciliation owns the outcome.
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventId, leaseRecoveryDistributionId), {
          decryptToken: async (stored) => stored,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("skipped");
    expect(publish).not.toHaveBeenCalled();

    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO provider_operations
           (org_id, distribution_id, operation, idempotency_key, status,
            publication_snapshot, media_hold_until, media_asset_ids)
         VALUES ($1, $2, 'publish', $3, 'started', $4::jsonb,
                 now() + ($5 * INTERVAL '1 second'), $6::uuid[])
         ON CONFLICT (distribution_id, operation, idempotency_key)
         DO NOTHING`,
        [
          organizationId,
          leaseRecoveryDistributionId,
          // The intent key the lost attempt claimed under, so a redelivery
          // finds this row instead of opening a second publish intent.
          `queue:${eventId}`,
          // The snapshot a lost attempt had already frozen: this Distribution
          // publishes `secondPostId`, whose single attachment is the second
          // Asset, so the retained bytes and the hold below are the ones that
          // attempt was actually retrieving.
          JSON.stringify({
            version: 1,
            post_id: secondPostId,
            content: {
              title: "Second launch",
              text: "Second caption",
              hashtags: [],
            },
            media: [
              {
                position: 0,
                asset_id: secondAssetId,
                asset_type: "image",
                rendition_id: secondRenditionId,
                object_id: secondRenditionObjectId,
                object_key: secondRenditionKey,
                content_type: "image/webp",
                file_size: 3072,
                etag: "etag-rendition-2",
                width: 1200,
                height: 1200,
                duration_sec: null,
              },
            ],
          }),
          // The hold window a live attempt really carries, so the assertion is
          // about the production retrieval lease rather than a hand-picked one.
          providerMediaRetrievalLeaseSeconds,
          // The indexed hold set cleanup probes without parsing the snapshot.
          [secondAssetId],
        ],
      ),
    );
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO provider_operation_media
           (operation_id, org_id, distribution_id, asset_id, brand_profile_id,
            rendition_id, object_id, object_key, position)
         SELECT operation.id, operation.org_id, operation.distribution_id,
                $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 0
         FROM provider_operations AS operation
         WHERE operation.distribution_id = $1
           AND operation.operation = 'publish'`,
        [
          leaseRecoveryDistributionId,
          secondAssetId,
          seededAlphaProfileId,
          secondRenditionId,
          secondRenditionObjectId,
          secondRenditionKey,
        ],
      ),
    );
    // The event that was claimed above has already reached its terminal
    // outcome, so the lease row is re-armed rather than inserted again: this
    // is what a delivery lost with the worker looks like, still `processing`
    // under a lease that has not yet lapsed.
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO async_job_events
           (event_key, job_type, aggregate_id, outcome, lease_expires_at,
            org_id, aggregate_type)
         VALUES ($1, 'distribution.publish.requested', $2, 'processing',
                 now() + ($3 * INTERVAL '1 second'), $4, 'distribution')
         ON CONFLICT (event_key) DO UPDATE
           SET outcome = 'processing',
               lease_expires_at = EXCLUDED.lease_expires_at,
               processed_at = NULL,
               updated_at = now()`,
        [
          `outbox:${eventId}`,
          leaseRecoveryDistributionId,
          distributionProcessingGraceSeconds,
          organizationId,
        ],
      ),
    );

    const held = await mediaHolds(leaseRecoveryDistributionId);
    expect(held).toEqual([
      {
        asset_id: secondAssetId,
        media_hold_until: expect.any(Date),
        object_key: secondRenditionKey,
        operation: "publish",
        position: 0,
      },
    ]);
    expect(held[0]!.media_hold_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("recovers a stalled attempt through reconciliation without republishing", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const eventId = eventIds[2]!;

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE async_job_events
         SET lease_expires_at = now() - INTERVAL '1 second'
         WHERE event_key = $1`,
        [`outbox:${eventId}`],
      ),
    );
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET updated_at = now() - ($2 * INTERVAL '1 second')
         WHERE id = $1`,
        [leaseRecoveryDistributionId, distributionProcessingGraceSeconds + 60],
      ),
    );

    await expect(Effect.runPromise(enqueueDueDistributions(env))).resolves.toBeGreaterThanOrEqual(
      1,
    );

    const recovered = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string;
        status: string;
        topic: string;
      }>(
        `SELECT distribution.status, distribution.failure_code,
                event.topic
         FROM distributions AS distribution
         LEFT JOIN outbox_events AS event
           ON event.aggregate_id = distribution.id
          AND event.topic = 'distribution.reconcile.requested'
          AND event.state IN ('pending', 'leased')
         WHERE distribution.id = $1`,
        [leaseRecoveryDistributionId],
      );
      return result.rows[0];
    });
    expect(recovered?.status).toBe("needs_reconciliation");
    expect(recovered?.failure_code).toBe("provider_outcome_ambiguous");
    expect(recovered?.topic).toBe("distribution.reconcile.requested");
    expect(publish).not.toHaveBeenCalled();
  });

  it("freezes the approved JPEG when the smaller ready WEBP is undeliverable", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-instagram",
    }));
    const mediaFor = byteResolver();

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET attachment_ids = ARRAY[$2]::uuid[]
         WHERE id = $1`,
        [mixedDistributionId, mixedAssetId],
      ),
    );

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[5]!, mixedDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: instagramRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");

    // Instagram rejects WEBP, so the smaller rendition is not a candidate and
    // the approved JPEG original is what the attempt may deliver.
    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      contentType: "image/jpeg",
      fileSize: 4096,
      objectKey: mixedJpegKey,
    });
    const [, , input] = publish.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { caption: string; media: Array<{ metadata?: unknown; url: string }> },
    ];
    expect(input.caption).toBe("Mixed launch\n\nMixed caption");
    // The delivered descriptor names the JPEG's own external bytes, and the
    // metadata is the object's verified geometry rather than the Asset row's
    // coarser declared type and size.
    expect(input.media).toEqual([
      {
        contentType: "image/jpeg",
        fileSize: 4096,
        metadata: { height: 2048, width: 2048 },
        mode: "remote_ingest",
        url: `https://media.example/${encodeURIComponent(mixedJpegKey)}`,
      },
    ]);
    // The freeze records exactly the delivered object, so the attempt cannot
    // drift onto the incompatible rendition on a later poll or reconciliation.
    expect((await publishSnapshot(mixedDistributionId))?.media).toEqual([
      {
        asset_id: mixedAssetId,
        asset_type: "image",
        content_type: "image/jpeg",
        duration_sec: null,
        etag: "etag-mixed-jpeg",
        file_size: 4096,
        height: 2048,
        object_id: mixedJpegObjectId,
        object_key: mixedJpegKey,
        position: 0,
        rendition_id: mixedOriginalRenditionId,
        width: 2048,
      },
    ]);
    expect(await mediaHolds(mixedDistributionId)).toEqual([
      {
        asset_id: mixedAssetId,
        media_hold_until: expect.any(Date),
        object_key: mixedJpegKey,
        operation: "publish",
        position: 0,
      },
    ]);
  });

  it("never falls back to an unreferenced original and holds each attachment's own object", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-carousel",
    }));
    const mediaFor = byteResolver();

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET attachment_ids = ARRAY[$2, $3]::uuid[]
         WHERE id = $1`,
        [mixedDistributionId, mixedAssetId, jpegAssetId],
      ),
    );

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[5]!, mixedDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: instagramRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");

    // The first attachment resolves to its verified original, the second to the
    // approved optimization output — `jpegAssetId`'s unreferenced original is
    // smaller but was never approved, so it is not a candidate at all.
    expect(mediaFor.mock.calls.map((call) => call[0])).toMatchObject([
      { objectKey: mixedJpegKey },
      { objectKey: jpegRenditionKey },
    ]);
    const [, , input] = publish.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { media: Array<{ url: string }> },
    ];
    expect(input.media.map((media) => media.url)).toEqual([
      `https://media.example/${encodeURIComponent(mixedJpegKey)}`,
      `https://media.example/${encodeURIComponent(jpegRenditionKey)}`,
    ]);
    const frozen = await publishSnapshot(mixedDistributionId);
    expect(frozen?.media.map((item) => [item.position, item.object_key])).toEqual([
      [0, mixedJpegKey],
      [1, jpegRenditionKey],
    ]);
    // Both chosen objects are held in the order they were delivered, so cleanup
    // cannot release bytes a still-running retrieval depends on.
    expect(await mediaHolds(mixedDistributionId)).toEqual([
      {
        asset_id: mixedAssetId,
        media_hold_until: expect.any(Date),
        object_key: mixedJpegKey,
        operation: "publish",
        position: 0,
      },
      {
        asset_id: jpegAssetId,
        media_hold_until: expect.any(Date),
        object_key: jpegRenditionKey,
        operation: "publish",
        position: 1,
      },
    ]);
  });

  it("refuses ready media on an Asset processing never approved", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const mediaFor = byteResolver();

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[6]!, unapprovedDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: instagramRegistry(publish),
        }),
      ),
    ).resolves.toBe("processed");

    // Every attachment holds a ready object behind a ready rendition reference,
    // yet none of those Assets is `ready`, so no object may be frozen or held.
    expect(mediaFor).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const outcome = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string;
        status: string;
      }>("SELECT status, failure_code FROM distributions WHERE id = $1", [
        unapprovedDistributionId,
      ]);
      return result.rows[0];
    });
    expect(outcome).toMatchObject({
      failure_code: "provider_media_unavailable",
      status: "failed",
    });
    // The attachments keep their positions with no frozen object rather than
    // leaving the composition, so the attempt fails instead of publishing
    // fewer attachments than the creator composed.
    expect((await publishSnapshot(unapprovedDistributionId))?.media).toEqual(
      unapprovedAssets.map((asset, index) => ({
        asset_id: asset.assetId,
        asset_type: "image",
        content_type: "image/jpeg",
        duration_sec: null,
        etag: null,
        file_size: 2048,
        height: 640,
        object_id: null,
        object_key: null,
        position: index,
        rendition_id: null,
        width: 640,
      })),
    );
    expect(await mediaHolds(unapprovedDistributionId)).toEqual([]);
  });
  it("rejects publication without freezing or dispatching when a post edit removes selected media", async () => {
    await resetCompositions();
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const mediaFor = mediaResolver();

    // 1. Target selection B/A: ordered selection of secondAssetId (B) and firstAssetId (A).
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET attachment_ids = ARRAY[$2, $3]::uuid[]
         WHERE id = $1`,
        [youtubeDistributionId, secondAssetId, firstAssetId],
      ),
    );

    // 2. Remove A from Post: attachment-only Post edit that detaches firstAssetId (A).
    await runSystemTransaction(env, (client) =>
      client.query(
        `DELETE FROM post_attachments
         WHERE post_id = $1 AND asset_id = $2`,
        [postId, firstAssetId],
      ),
    );

    // 3. Attempt work through existing public distribution processing path.
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[0]!, youtubeDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("skipped");

    // 4. Assert no external publish and no media resolution occurred.
    expect(publish).not.toHaveBeenCalled();
    expect(mediaFor).not.toHaveBeenCalled();

    // 5. Assert no incomplete snapshot was frozen in provider_operations.
    expect(await publishSnapshot(youtubeDistributionId)).toBeUndefined();
    expect(await mediaHolds(youtubeDistributionId)).toEqual([]);

    // 6. Assert correct failed outcome on the distribution record.
    const outcome = await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attachment_ids: string[] | null;
        error_message: string | null;
        failure_code: string | null;
        failure_retryable: boolean | null;
        next_attempt_at: Date | null;
        status: string;
      }>(
        `SELECT status, failure_code, failure_retryable, error_message,
                attachment_ids, next_attempt_at
         FROM distributions
         WHERE id = $1`,
        [youtubeDistributionId],
      );
      return result.rows[0];
    });

    expect(outcome).toMatchObject({
      failure_code: "provider_media_unavailable",
      failure_retryable: false,
      next_attempt_at: null,
      status: "failed",
    });
    // The target's ordered selection B/A is preserved in settled history.
    expect(outcome?.attachment_ids).toEqual([secondAssetId, firstAssetId]);
  });
});
