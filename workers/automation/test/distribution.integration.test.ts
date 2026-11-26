import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import { Effect } from "effect";
import {
  createInstagramAdapter,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { systemPoolFor } from "../src/database";
import { enqueueDueDistributions, processDistributionMessage } from "../src/distribution";
import { distributionProcessingGraceSeconds } from "../src/due-work";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { providerMediaRetrievalLeaseSeconds } from "../src/provider-media";
import { runSystemTransaction } from "./system-transaction";
import { fakePlatformCapability } from "./test-doubles";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

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
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies AutomationEnv;

function youtubeRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      ...fakePlatformCapability("youtube"),
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
  });
  return registry;
}

function instagramRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("instagram", {
    capability: {
      ...fakePlatformCapability("instagram"),
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
  });
  return registry;
}

function threadsRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("threads", {
    capability: {
      ...fakePlatformCapability("threads"),
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
  });
  return registry;
}

function facebookRegistry(publish: NonNullable<ProviderAdapter["publish"]>): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("facebook", {
    capability: {
      ...fakePlatformCapability("facebook"),
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
  });
  return registry;
}

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
    await client.query(`DELETE FROM post_attachments WHERE post_id = $1`, [postId]);
    await client.query(
      `INSERT INTO post_attachments
         (post_id, asset_id, org_id, brand_profile_id, position)
       VALUES ($1, $2, $3, $4, 0), ($1, $5, $3, $4, 1)`,
      [postId, firstAssetId, organizationId, seededAlphaProfileId, secondAssetId],
    );
    await client.query(
      `UPDATE distributions
       SET status = 'queued', attempt_count = 0, reconciliation_attempt_count = 0,
           provider_operation_id = NULL, platform_post_id = NULL, provider_warnings = '[]'::jsonb,
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
           provider_operation_id = NULL, platform_post_id = NULL, provider_warnings = '[]'::jsonb,
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
         SET updated_at = now()
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
    const publish = vi.fn<NonNullable<ProviderAdapter["publish"]>>(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "provider-post-2",
      providerUrl: "https://provider.example/watch/2?access_token=must-not-persist",
    }));
    const mediaFor = mediaResolver();

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
    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      objectKey: firstRenditionKey,
    });
    const input = publish.mock.calls[0]![2];
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
    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      objectKey: secondRenditionKey,
    });
    expect(publish).toHaveBeenCalledOnce();
    const snapshot = await publishSnapshot(partialDistributionId);
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

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, publishMessage(eventIds[1]!, partialDistributionId), {
          decryptToken: async (stored) => stored,
          mediaFor: mediaResolver(),
          providerRegistry: threadsRegistry(succeeded),
        }),
      ),
    ).resolves.toBe("processed");
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
    expect(await publishSnapshot(rejectedDistributionId)).toMatchObject({
      post_id: postId,
    });
  });

  it("no-ops a publish delivery whose attempt the row records as in flight", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const eventId = eventIds[2]!;

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
          `queue:${eventId}`,
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
          providerMediaRetrievalLeaseSeconds,
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
  });

  it("recovers a stalled attempt through a reconciliation trigger, never a second publish", async () => {
    await resetCompositions();
    const eventId = eventIds[2]!;

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE distributions
         SET status = 'processing',
             updated_at = now() - ($2 * INTERVAL '1 second')
         WHERE id = $1`,
        [leaseRecoveryDistributionId, distributionProcessingGraceSeconds + 60],
      );
      await client.query(
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
          `queue:${eventId}`,
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
          providerMediaRetrievalLeaseSeconds,
          [secondAssetId],
        ],
      );
      await client.query(
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
      );
      await client.query(
        `INSERT INTO async_job_events
           (event_key, job_type, aggregate_id, outcome, lease_expires_at,
            org_id, aggregate_type)
         VALUES ($1, 'distribution.publish.requested', $2, 'processing',
                 now() - INTERVAL '1 second', $3, 'distribution')
         ON CONFLICT (event_key) DO UPDATE
           SET outcome = 'processing',
               lease_expires_at = EXCLUDED.lease_expires_at,
               processed_at = NULL,
               updated_at = now()`,
        [`outbox:${eventId}`, leaseRecoveryDistributionId, organizationId],
      );
    });

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
    const reconcileEvents = await runSystemTransaction(env, (client) =>
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM outbox_events
          WHERE aggregate_id = $1 AND topic = 'distribution.reconcile.requested'`,
        [leaseRecoveryDistributionId],
      ),
    );
    expect(reconcileEvents.rows[0]?.count).toBe("1");
    const held = await mediaHolds(leaseRecoveryDistributionId);
    expect(held.map((row) => row.object_key)).toEqual([secondRenditionKey]);
    expect(held[0]!.media_hold_until!.getTime()).toBeGreaterThan(Date.now());
    expect(recovered?.status).toBe("needs_reconciliation");
    expect(recovered?.failure_code).toBe("provider_outcome_ambiguous");
    expect(recovered?.topic).toBe("distribution.reconcile.requested");
    const publishCommands = await runSystemTransaction(env, (client) =>
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM outbox_events
          WHERE aggregate_id = $1 AND topic = 'distribution.publish.requested'
            AND state IN ('pending', 'leased')`,
        [leaseRecoveryDistributionId],
      ),
    );
    expect(publishCommands.rows[0]?.count).toBe("0");
  });

  it("keeps Instagram partial success published and blocks a later publish trigger", async () => {
    await resetCompositions();
    await runSystemTransaction(env, (client) =>
      client.query("UPDATE distributions SET attachment_ids = ARRAY[$2]::uuid[] WHERE id = $1", [
        mixedDistributionId,
        mixedAssetId,
      ]),
    );
    let finalWrites = 0;
    const registry = new ProviderRegistry();
    registry.register(
      "instagram",
      createInstagramAdapter({
        clientId: "partial-client",
        clientSecret: "partial-secret",
        redirectUri: "https://api.example/callback",
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname.endsWith("/media")) return Response.json({ id: "partial-container" });
          if (url.pathname.endsWith("/partial-container")) {
            return Response.json({ id: "partial-container", status_code: "FINISHED" });
          }
          if (url.pathname.endsWith("/media_publish")) {
            finalWrites++;
            return Response.json({ id: "partial-post", config_issue: "CAPTION_NOT_ATTACHED" });
          }
          throw new Error(`Unexpected Instagram request: ${url.pathname}`);
        },
      }),
    );
    const dependencies = {
      decryptToken: async (stored: string) => stored,
      mediaFor: mediaResolver(),
      providerRegistry: registry,
    };
    const message = publishMessage("distribution-integration-partial-warning", mixedDistributionId);
    await expect(
      Effect.runPromise(processDistributionMessage(env, message, dependencies)),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        processDistributionMessage(
          env,
          {
            ...message,
            event_id: `${message.event_id}-reconcile`,
            topic: "distribution.reconcile.requested",
          },
          dependencies,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        processDistributionMessage(
          env,
          {
            ...message,
            event_id: `${message.event_id}-redelivery`,
          },
          dependencies,
        ),
      ),
    ).resolves.toBe("skipped");
    const outcome = await runSystemTransaction(env, (client) =>
      client.query<{
        status: string;
        platform_post_id: string;
        provider_warnings: string[];
        failure_code: string | null;
      }>(
        "SELECT status, platform_post_id, provider_warnings, failure_code FROM distributions WHERE id = $1",
        [mixedDistributionId],
      ),
    );
    expect(outcome.rows[0]).toEqual({
      status: "published",
      platform_post_id: "partial-post",
      failure_code: null,
      provider_warnings: ["instagram_publish_partial"],
    });
    expect(finalWrites).toBe(1);
  });

  it("freezes the approved JPEG when the smaller ready WEBP is undeliverable", async () => {
    await resetCompositions();
    const publish = vi.fn<NonNullable<ProviderAdapter["publish"]>>(async () => ({
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

    expect(mediaFor).toHaveBeenCalledTimes(1);
    expect(mediaFor.mock.calls[0]![0]).toMatchObject({
      contentType: "image/jpeg",
      fileSize: 4096,
      objectKey: mixedJpegKey,
    });
    const input = publish.mock.calls[0]![2];
    expect(input.caption).toBe("Mixed launch\n\nMixed caption");
    expect(input.media).toEqual([
      {
        contentType: "image/jpeg",
        fileSize: 4096,
        metadata: { height: 2048, width: 2048 },
        mode: "remote_ingest",
        url: `https://media.example/${encodeURIComponent(mixedJpegKey)}`,
      },
    ]);
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
    const publish = vi.fn<NonNullable<ProviderAdapter["publish"]>>(async () => ({
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

    expect(mediaFor.mock.calls.map((call) => call[0])).toMatchObject([
      { objectKey: mixedJpegKey },
      { objectKey: jpegRenditionKey },
    ]);
    const input = publish.mock.calls[0]![2];
    expect(
      (input.media ?? []).map((media) => (media.mode === "remote_ingest" ? media.url : undefined)),
    ).toEqual([
      `https://media.example/${encodeURIComponent(mixedJpegKey)}`,
      `https://media.example/${encodeURIComponent(jpegRenditionKey)}`,
    ]);
    const frozen = await publishSnapshot(mixedDistributionId);
    expect(frozen?.media.map((item) => [item.position, item.object_key])).toEqual([
      [0, mixedJpegKey],
      [1, jpegRenditionKey],
    ]);
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

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET attachment_ids = ARRAY[$2, $3]::uuid[]
         WHERE id = $1`,
        [youtubeDistributionId, secondAssetId, firstAssetId],
      ),
    );

    await runSystemTransaction(env, (client) =>
      client.query(
        `DELETE FROM post_attachments
         WHERE post_id = $1 AND asset_id = $2`,
        [postId, firstAssetId],
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
    ).resolves.toBe("skipped");

    expect(publish).not.toHaveBeenCalled();
    expect(mediaFor).not.toHaveBeenCalled();

    expect(await publishSnapshot(youtubeDistributionId)).toBeUndefined();
    expect(await mediaHolds(youtubeDistributionId)).toEqual([]);

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
    expect(outcome?.attachment_ids).toEqual([secondAssetId, firstAssetId]);
  });
});
