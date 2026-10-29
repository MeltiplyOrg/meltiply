import {
  type DatabaseError,
  MailSubmissionError,
  StorageUnavailableError,
  type Platform,
  type PlatformCapability,
  COMMUNITY_LIMITS,
} from "@meltiply/domain";
import {
  classifyProviderFailure,
  createProviderServiceLive,
  ProviderAdapterError,
  type ProviderCredentials,
  ProviderRegistry,
  type ProviderRequestContext,
} from "@meltiply/providers";
import type { JwtIdentity } from "@meltiply/auth";
import type { TransactionClient } from "@meltiply/database";
import { Effect } from "effect";
import {
  createStorageServiceTest,
  type EffectMultipartUpload,
  type ObjectMetadata,
  readyObjectKey,
  type StorageServiceShape,
} from "@meltiply/storage";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type * as Domain from "@meltiply/domain";

// Exercise finite-policy boundaries even though community deployments are
// unrestricted. Individual scenarios also load the real community policy.
vi.mock("@meltiply/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  COMMUNITY_LIMITS: {
    max_distributions: 30,
    max_platforms: 2,
    max_storage_bytes: 1024 * 1024 * 1024,
    max_uploads: 10,
  },
}));

import {
  resolveActor as resolveActorWithRequestId,
  type ResolvedActor,
} from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { createAssetApiService } from "../src/asset-service";
import { createCoreApiService } from "../src/core-service";
import { createPostApiService } from "../src/post-service";
import type { PostApiService, PostTargetInput } from "../src/post-types";
import type { components } from "@meltiply/contracts/schema";
import {
  authenticatedPoolFor,
  systemPoolFor,
  withSystemTransactionEffect,
  type EffectTransactionClient,
} from "../src/database";

import type { ApiWorkerEnv } from "../src/env";
import { createMailServiceTest, type MailMessage, type MailServiceShape } from "../src/mail";
import { saveOAuthConnectionEffect } from "../src/oauth-connection";
import { revokeOAuthConnectionEffect } from "../src/oauth-revoke";
import { getPublicationRequirementsEffect } from "../src/publication-requirements";
import { createOperatorReconciliationService } from "../src/operator-reconciliation";
import { tokenCipherFor } from "../src/token-credentials";
import { isoPeriodKey } from "../src/time";

/**
 * Runs saveOAuthConnectionEffect to completion at the test boundary.
 *
 * Integration callers assert on the resolved value, so each call executes the
 * identical Effect program the routes compose via Effect.runPromise.
 */
function saveOAuthConnection(...args: Parameters<typeof saveOAuthConnectionEffect>): Promise<void> {
  return Effect.runPromise(saveOAuthConnectionEffect(...args));
}

/**
 * Runs revokeOAuthConnectionEffect with the live provider layer at the test boundary.
 *
 * Routes compose the Effect inside runRouteEffect; integration callers execute it
 * here via Effect.runPromise so tenant-isolation assertions observe identical
 * typed failures.
 */
function revokeOAuthConnection(
  ...args: Parameters<typeof revokeOAuthConnectionEffect>
): Promise<void> {
  const [env, session, accountId, registry] = args;
  return Effect.runPromise(
    Effect.provide(
      revokeOAuthConnectionEffect(env, session, accountId, registry),
      createProviderServiceLive(registry),
    ),
  );
}

/**
 * Runs getPublicationRequirementsEffect with the live provider layer at the test boundary.
 *
 * Preserves the optional reference timestamp argument so tenant-isolation
 * assertions observe identical typed failures to the routed operation.
 */
function getPublicationRequirements(...args: Parameters<typeof getPublicationRequirementsEffect>) {
  const [env, session, accountId, requestId, registry, now] = args;
  return Effect.runPromise(
    Effect.provide(
      getPublicationRequirementsEffect(env, session, accountId, requestId, registry, now),
      createProviderServiceLive(registry),
    ),
  );
}

/**
 * Executes a system-pool Effect transaction at the test boundary.
 *
 * Integration fixtures and assertions share the same privileged, non-RLS
 * connection the worker uses for provisioning and reconciliation, so each
 * callback composes plain client.query Effects inside one commit scope.
 */
function systemTransaction<A, E>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(withSystemTransactionEffect(env, operation));
}

/**
 * Narrows an API error-envelope body to its machine-readable code. Returns
 * undefined for any non-conforming payload instead of trusting a cast.
 *
 * @param value - Decoded JSON error response.
 * @returns The `error.code` string when present and well-shaped.
 */
function errorCodeFrom(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    value.error !== null &&
    typeof value.error === "object" &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return undefined;
}

/**
 * Builds the verified Better Auth JWT identity the bearer middleware hands to
 * resolveActor, so the integration suite exercises its real provisioning path
 * against the database without a Better Auth session lookup.
 */
function jwtIdentity(user: { email: string; id: string; name?: string | null }): JwtIdentity {
  return {
    email: user.email,
    name: user.name ?? undefined,
    subject: user.id,
  };
}

/**
 * Issues an actor-resolution request; the bearer JWT is already verified by
 * the tenant middleware, so the request only carries routing headers such as
 * the x-workspace-id selection.
 */
function actorRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.meltiply.local/api/v1/platforms", {
    headers,
  });
}

/** Resolves an actor with the middleware request id the app supplies. */
function resolveActor(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
  request: Request,
): Promise<ResolvedActor> {
  return resolveActorWithRequestId(env, identity, request, "core-service-test-request");
}

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  APP_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Fixed bearer JWT credential for HTTP-level requests; the `verifyJwtToken`
// test double maps it to the seeded identity under test.
const bearerAuthorization = "Bearer test-only.jwt";
const personalActorUserId = "auth_user_worker_actor_personal_test";
const organizationActorUserId = "auth_user_worker_actor_org_test";
const organizationActorOrgId = "20000000-0000-4000-8000-000000000010";
const personalProvisionUserId = "auth_user_worker_personal_provision_test";
const personalRecoveryUserId = "auth_user_worker_personal_recovery_test";
const lifecycleUserId = "auth_user_worker_lifecycle_test";
const lifecycleMemberId = "auth_user_worker_lifecycle_member_test";
const lifecycleWorkspaceSlug = "worker-lifecycle-test";

// Seeded Better Auth subjects and internal IDs from
// scripts/cloudflare-local/postgres/seed.sql: claims carry the auth subject,
// the internal users.id, and the resolved workspace UUID so tenant
// transactions resolve through public.auth_active_org_id().
const alpha = {
  organizationId: "20000000-0000-4000-8000-000000000001",
  organizationRole: "admin",
  subject: "auth_user_local_alpha",
  userId: "10000000-0000-4000-8000-000000000001",
};

const beta = {
  organizationId: "20000000-0000-4000-8000-000000000002",
  organizationRole: "admin",
  subject: "auth_user_local_beta",
  userId: "10000000-0000-4000-8000-000000000002",
};

// Seeded Brand Profiles from scripts/cloudflare-local/postgres/seed.sql: each
// workspace owns exactly one active profile, and every asset, platform account,
// distribution, OAuth connection, and reply fixture must name the profile that
// belongs to its tenant.
const alphaBrandProfileId = "a0000000-0000-4000-8000-000000000001";
const betaBrandProfileId = "a0000000-0000-4000-8000-000000000002";

// Fixture Post identities created directly so a Distribution fixture can point
// at real composition rows. The 4e00… range is disjoint from the seeded 4800…
// team posts and the e100… personal posts, so deleting one never touches
// seeded composition that other specs read.
const fixturePostIds = {
  auditPublished: "4e000000-0000-4000-8000-000000000020",
  auditFailed: "4e000000-0000-4000-8000-000000000021",
  auditCancelled: "4e000000-0000-4000-8000-000000000022",
  snapshotless: "4e000000-0000-4000-8000-000000000030",
  disconnectScheduled: "4e000000-0000-4000-8000-000000000009",
  disconnectInFlight: "4e000000-0000-4000-8000-000000000010",
} as const;

/**
 * Inserts the Post, attachment, and target rows a Distribution fixture must own.
 *
 * Migration 003 made composition Post-owned: a Distribution references
 * `posts.post_id`, and the ordered media and the per-Channel selection live on
 * `post_attachments` / `post_targets`. Fixture Distributions therefore cannot
 * be inserted as bare rows; they need the same composition a scheduled Post
 * would have. Rows land at position 0 in attachment order, matching a
 * single-media Post, and `attachment_ids` snapshots that order on the target
 * exactly as `post-service` does when it writes a schedule.
 *
 * @param client - Transaction client shared with the calling fixture block.
 * @param input - Post identity, optional attachment/Channel, and an optional owner pair; defaults to Alpha's RLS fixture scope.
 * @returns Effect inserting the Post and, when supplied, its children.
 */
function insertFixturePost(
  client: EffectTransactionClient,
  input: {
    accountId?: string;
    assetId?: string;
    owner?: { organizationId: string; brandProfileId: string };
    postId: string;
    title: string;
  },
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const organizationId = input.owner?.organizationId ?? alpha.organizationId;
    const brandProfileId = input.owner?.brandProfileId ?? alphaBrandProfileId;
    yield* client.query(
      `INSERT INTO posts (id, org_id, brand_profile_id, title, status)
       VALUES ($1, $3, $4, $2, 'active')`,
      [input.postId, input.title, organizationId, brandProfileId],
    );
    if (input.assetId !== undefined) {
      yield* client.query(
        `INSERT INTO post_attachments
           (post_id, asset_id, org_id, brand_profile_id, position)
         VALUES ($1, $2, $3, $4, 0)`,
        [input.postId, input.assetId, organizationId, brandProfileId],
      );
    }
    if (input.accountId !== undefined) {
      yield* client.query(
        `INSERT INTO post_targets
           (post_id, platform_account_id, org_id, brand_profile_id,
            attachment_ids)
         VALUES ($1, $2, $4, $5,
                 CASE WHEN $3::uuid IS NULL THEN NULL
                      ELSE ARRAY[$3::uuid] END)`,
        [input.postId, input.accountId, input.assetId ?? null, organizationId, brandProfileId],
      );
    }
  });
}

/** Minimal shape of a scheduled Post read used to key outcomes by Channel. */
interface PostWithDistributions {
  distributions: readonly {
    id: string;
    platform_account_id: string | null;
  }[];
}

/**
 * Resolves one scheduled Distribution by the Channel it publishes to.
 *
 * `Post.distributions` is an unordered collection in the contract, and the read
 * orders rows by `event_at DESC, id DESC` over random Distribution ids, so a
 * positional index does not identify a Channel. Scenarios that act on one
 * Channel's outcome look it up by `platform_account_id`, which is the key the
 * composer actually chose.
 *
 * @param post - Scheduled Post read model carrying its Distribution rows.
 * @param platformAccountId - Channel the wanted Distribution publishes to.
 * @returns Id of that Channel's Distribution row.
 * @throws {Error} When no row targets the Channel, which fails the scenario
 * instead of silently asserting against another Channel's outcome.
 */
function distributionIdForChannel(post: PostWithDistributions, platformAccountId: string): string {
  const row = post.distributions.find(
    (distribution) => distribution.platform_account_id === platformAccountId,
  );
  if (row === undefined) {
    throw new Error(
      `No Distribution targets ${platformAccountId} among ${post.distributions.length} rows.`,
    );
  }
  return row.id;
}

// Extra Alpha Channel the TikTok publishing-options scenario schedules to. It
// is seeded here because the scenario asserts on TikTok-specific provider
// options, which only a real connected TikTok Channel can accept.
const alphaTiktokAccountId = "94000000-0000-4000-8000-000000000203";

const alphaActor: ResolvedActor = {
  authUserId: alpha.subject,
  claims: alpha,
  displayName: "Alpha Creator",
  email: "alpha@meltiply.local",
  isInstallationOwner: true,
  role: "admin",
  userId: alpha.userId,
  workspace: {
    id: alpha.organizationId,
    name: "Alpha Studio",
    slug: "alpha-studio",
  },
};

// Verified JWT identity for the seeded Alpha user; `verifyJwtToken` doubles
// return it so HTTP-level tests authenticate as the same subject the seeded
// users row binds.
const alphaIdentity: JwtIdentity = {
  email: "alpha@meltiply.local",
  name: "Alpha Creator",
  subject: alpha.subject,
};

const service = createCoreApiService();
/**
 * The `usage_records.period` key distribution acceptance charges.
 * `usageGuardEffect` derives the key from `new Date()`,
 * so they read the real calendar month — the same row `seed.sql` writes. A
 * fixture that seeded a publication counter under any other key would leave
 * the gate reading an untouched counter and admitting work the workspace has
 * no room for.
 */
const currentUsagePeriod = isoPeriodKey(new Date());

/**
 * The `usage_records.period` key the upload gates charge. `assetServiceHarness`
 * injects a fixed clock at 2026-07-18 and `createUploadSession` derives its
 * period from that clock, so the upload and storage counters it reads live in
 * 2026-07 no matter which month the suite actually runs in. The seeded row is
 * irrelevant to these scenarios: it is keyed to the real month.
 */
const assetTestPeriod = "2026-07";
let usageBeforeAssetTests: { storage_bytes: string; uploads: string } | undefined;

/**
 * Seeds a Better Auth subject ("user" row) for invitation-lifecycle scenarios.
 *
 * `resolveActor` binds the internal `users` identity lazily on the first
 * authenticated request, so scenarios only need the auth row up front.
 *
 * @param subject - Better Auth subject id; must be unique per test.
 * @param email - Subject email; doubles as the invitation recipient.
 * @param name - Display name used for the provisioned identity.
 */
function seedLifecycleUser(subject: string, email: string, name: string): Promise<unknown> {
  return systemTransaction(env, (client) =>
    client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified")
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [subject, name, email],
    ),
  );
}

/**
 * Extracts the invitation acceptance token from the captured `MailMessage`.
 * The link is rendered identically in the HTML `href` and the text body;
 * this helper reads the text body's `Accept the invitation:` line.
 *
 * @param message - Message captured through the injected mail service.
 * @returns Raw invitation token for the accept route.
 */
function invitationTokenFrom(message: MailMessage): string {
  const match = /Accept the invitation: (\S+)/.exec(message.text);
  const link = match?.[1];
  if (link === undefined) {
    throw new Error("Invitation message must contain an acceptance link.");
  }
  const token = new URL(link).searchParams.get("token");
  if (token === null) {
    throw new Error("Invitation acceptance link must carry a token.");
  }
  return token;
}

/**
 * Produces the per-run token that scopes invitation-scenario workspace slugs
 * and `Idempotency-Key` values. Seeded subjects and their personal workspaces
 * persist across local suite runs, so a fixed key would replay a stored
 * response (or conflict) instead of exercising the fresh request path.
 *
 * @returns 8-character lowercase hex token unique to this invocation.
 */
function lifecycleRunToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Builds an API app wired for invitation-lifecycle scenarios: the real
 * `resolveActor`/`verifyJwtToken` seam authenticates bearer identities, and
 * the shared `MailService` seam is provided through a `createMailServiceTest`
 * Layer that captures the neutral `MailMessage` per send. `useLiveMail`
 * exercises the production path, where the test env's missing `MAIL` binding
 * and sender configuration surface as `email_unavailable`.
 *
 * @param options.identities - Bearer token suffix to verified JWT identity.
 * @param options.send - Optional send override run after capture.
 * @param options.useLiveMail - Resolve the live sender instead of a test Layer.
 * @returns App, request helper, and the captured outbound messages.
 */
function lifecycleInvitationHarness(options: {
  identities: Readonly<Record<string, JwtIdentity>>;
  send?: MailServiceShape["send"];
  useLiveMail?: boolean;
}) {
  const sent: MailMessage[] = [];
  const fallback = Object.values(options.identities)[0]!;
  const app = createApiApp({
    resolveActor,
    verifyJwtToken: async (_envArg, token) => options.identities[token] ?? fallback,
    workspaceLifecycle: options.useLiveMail
      ? {}
      : {
          mailServiceLayer: createMailServiceTest({
            send: (message) => {
              sent.push(message);
              return options.send !== undefined
                ? options.send(message)
                : Effect.succeed({ submissionId: "test-submission-id" });
            },
          }),
        },
  });
  const request = (
    path: string,
    init: {
      body?: string;
      headers?: Record<string, string>;
      method: string;
    },
    as = "owner",
  ) =>
    app.request(
      path,
      {
        body: init.body,
        headers: {
          Authorization: `Bearer ${as}`,
          ...init.headers,
        },
        method: init.method,
      },
      env,
    );
  return { app, request, sent };
}

/**
 * Capability list with the requested Platforms opted into publishing.
 *
 * The registry ships every adapter as explicitly unavailable, so a scheduling
 * scenario opts one or more Platforms into publishing with the media limits its
 * fixture uses. Both the Post scheduler and the per-Distribution operations
 * validate against the same list, which is why the builder is shared.
 *
 * @param platform - Platform(s) to enable for publishing.
 * @param patch - Extra capability fields overriding the defaults.
 * @returns Registry capabilities with the requested publish override.
 */
function publishableCapabilities(
  platform: Platform | readonly Platform[],
  patch: Partial<PlatformCapability> = {},
) {
  const platforms = typeof platform === "string" ? [platform] : platform;
  const limits =
    platform === "tiktok"
      ? { max_file_size: 20 * 1024 * 1024 }
      : { max_file_size: 25 * 1024 * 1024 };
  return new ProviderRegistry().capabilities().map((capability) =>
    platforms.includes(capability.platform)
      ? {
          ...capability,
          accepted_mime_types: ["image/png"],
          asset_types: ["image" as const],
          publish: true,
          ...limits,
          ...patch,
        }
      : capability,
  );
}

/** Core service for per-Distribution operations against publish-enabled Platforms. */
function distributionServiceWith(
  platform: Platform | readonly Platform[] = "youtube",
  patch: Partial<PlatformCapability> = {},
) {
  return createCoreApiService(publishableCapabilities(platform, patch));
}

/**
 * Post composition service for the Platforms that can publish.
 *
 * Scheduling validates the resolved caption, media, and provider options
 * against the platform capability before any Distribution is accepted, so
 * every scheduling scenario must build the service with the platform(s) it
 * intends to publish to.
 *
 * @param platform - Platform(s) the scenario schedules against.
 * @param patch - Extra capability fields overriding the defaults.
 * @returns Post service whose scheduler accepts those platforms.
 */
function postServiceWith(
  platform: Platform | readonly Platform[],
  patch: Partial<PlatformCapability> = {},
) {
  return createPostApiService(publishableCapabilities(platform, patch));
}

/**
 * Builds deterministic Effect-native storage, signing, clock and UUID fixtures.
 * Storage mocks stay mutable for failure/race injection; side effects run only
 * when their Effects execute. The returned `service` is the Effect-native
 * AssetApiService: HTTP callers inject it into createApiApp, while direct test
 * calls execute each operation via Effect.runPromise at the call boundary.
 */
function assetServiceHarness(ids: string[]) {
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const objects = new Map<string, ObjectMetadata>();
  const multipartKeys: string[] = [];
  const storageEvents: string[] = [];
  const uploadKeys: string[] = [];
  const deletedKeys: string[] = [];
  const signedGets: Parameters<StorageServiceShape["signDownload"]>[0][] = [];
  const multipart = (key: string, uploadId: string): EffectMultipartUpload => ({
    abort: vi.fn(() =>
      Effect.sync(() => {
        storageEvents.push(`abort:${key}`);
      }),
    ),
    complete: vi.fn(() =>
      Effect.suspend(() => {
        const value = objects.get(key);
        return value
          ? Effect.succeed(value)
          : Effect.fail(
              new StorageUnavailableError({
                message: "missing integration object metadata",
              }),
            );
      }),
    ),
    uploadId,
    uploadPart: vi.fn((partNumber: number) =>
      Effect.succeed({
        etag: `etag-${partNumber}`,
        partNumber,
      }),
    ),
  });
  const storage = {
    createMultipartUpload: vi.fn<StorageServiceShape["createMultipartUpload"]>((key) =>
      Effect.sync(() => {
        multipartKeys.push(key);
        storageEvents.push(`create:${key}`);
        return multipart(key, `native-${ids[1]}`);
      }),
    ),
    delete: vi.fn<StorageServiceShape["delete"]>((key) =>
      Effect.sync(() => {
        deletedKeys.push(key);
        objects.delete(key);
      }),
    ),
    head: vi.fn<StorageServiceShape["head"]>((key) => Effect.sync(() => objects.get(key) ?? null)),
    readPrefix: vi.fn<StorageServiceShape["readPrefix"]>(() => Effect.succeed(null)),
    resumeMultipartUpload: vi.fn<StorageServiceShape["resumeMultipartUpload"]>((key, uploadId) =>
      Effect.succeed(multipart(key, uploadId)),
    ),
    signDownload: vi.fn<StorageServiceShape["signDownload"]>((request) =>
      Effect.sync(() => {
        signedGets.push(request);
        const purpose = request.downloadFilename ? "download" : "preview";
        return `https://r2.example/${purpose}/${request.key}`;
      }),
    ),
    signMultipartPart: vi.fn<StorageServiceShape["signMultipartPart"]>(({ key, partNumber }) =>
      Effect.succeed(`https://r2.example/upload/${key}?partNumber=${partNumber}`),
    ),
    signUpload: vi.fn<StorageServiceShape["signUpload"]>(({ key }) =>
      Effect.sync(() => {
        uploadKeys.push(key);
        return `https://r2.example/upload/${key}`;
      }),
    ),
  };
  const remainingIds = [...ids];
  const service = createAssetApiService({
    now: () => new Date(currentTime),
    randomUUID: () => {
      const id = remainingIds.shift();
      if (!id) throw new Error("integration UUID sequence exhausted");
      return id;
    },
    storageServiceLayer: createStorageServiceTest(storage),
  });
  return {
    deletedKeys,
    multipartKeys,
    storageEvents,
    objects,
    service,
    storage,
    setNow(value: string) {
      currentTime = new Date(value);
    },
    signedGets,
    uploadKeys,
  };
}

const analyticsCachePostId = "4f000000-0000-4000-8000-000000000090";
const analyticsCacheDistributionId = "96000000-0000-4000-8000-000000000090";
const analyticsCacheStart = new Date("2031-05-01T00:00:00Z");
const analyticsCacheEnd = new Date("2031-05-31T23:59:59Z");

/**
 * Seeds the published Distribution and first snapshot used by every analytics
 * cache scenario. The 2031 window is disjoint from seeded and other fixture
 * data, so a warm or expired result can only come from these rows.
 *
 * @param owner - Owning scope; defaults to Alpha's database-only RLS Workspace, while HTTP tests pass the resolved shared Workspace.
 * @returns Resolves after the Post, Distribution, and snapshot commit.
 */
async function seedAnalyticsCacheFixture(
  owner = { organizationId: alpha.organizationId, brandProfileId: alphaBrandProfileId },
): Promise<void> {
  await systemTransaction(env, (client) =>
    Effect.gen(function* () {
      yield* insertFixturePost(client, {
        postId: analyticsCachePostId,
        title: "Integration cached analytics",
        owner,
      });
      yield* client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform, status,
            published_at, platform_post_id)
         VALUES ($1, $2, $3, $4, 'instagram', 'published',
                 '2031-05-05T12:00:00Z', 'integration-cached-analytics')`,
        [
          analyticsCacheDistributionId,
          owner.organizationId,
          owner.brandProfileId,
          analyticsCachePostId,
        ],
      );
      yield* client.query(
        `INSERT INTO analytics_snapshots
           (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
         VALUES ($1, $2, 100, 10, 1, 2, '2031-05-06T12:00:00Z')`,
        [analyticsCacheDistributionId, owner.organizationId],
      );
    }),
  );
}

/**
 * Appends a later snapshot inside the cache fixture's reporting window.
 *
 * A retained summary keeps the earlier totals until its absolute expiration,
 * while a canonical recomputation reads this newest snapshot.
 *
 * @param values - Metric values for the new snapshot; defaults to the 400-view change.
 * @returns Resolves after the snapshot commits.
 */
async function addAnalyticsCacheSnapshot(values: {
  comments: number;
  likes: number;
  shares: number;
  views: number;
}): Promise<void> {
  await systemTransaction(env, (client) =>
    client.query(
      `INSERT INTO analytics_snapshots
         (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2031-05-07T12:00:00Z')`,
      [
        analyticsCacheDistributionId,
        alpha.organizationId,
        values.views,
        values.likes,
        values.comments,
        values.shares,
      ],
    ),
  );
}

/** Removes the analytics cache fixture rows without touching seeded data. */
async function removeAnalyticsCacheFixture(): Promise<void> {
  await systemTransaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query("DELETE FROM distributions WHERE post_id = $1", [analyticsCachePostId]);
      yield* client.query("DELETE FROM posts WHERE id = $1", [analyticsCachePostId]);
    }),
  );
}

describeIntegration("Worker core service with PostgreSQL RLS", () => {
  beforeAll(async () => {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query("DELETE FROM organizations WHERE id = $1", [organizationActorOrgId]);
        yield* client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
          [
            personalActorUserId,
            organizationActorUserId,
            personalProvisionUserId,
            personalRecoveryUserId,
            lifecycleUserId,
            lifecycleMemberId,
          ],
        ]);
        yield* client.query(
          `DELETE FROM outbox_events
         WHERE topic = 'telemetry.legacy_asset_upload_url.called'
           AND dedupe_key LIKE '91000000-%'`,
        );
      }),
    );
    await seedPostCompositionFixtures();
  });

  afterAll(async () => {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `DELETE FROM outbox_events
         WHERE (
             topic LIKE 'asset.%'
             OR topic = 'telemetry.legacy_asset_upload_url.called'
           )
           AND (
             dedupe_key LIKE '91000000-%'
             OR aggregate_id IN (
               SELECT id
               FROM assets
               WHERE title LIKE 'Integration asset %'
             )
           )`,
        );
        yield* client.query("DELETE FROM assets WHERE title LIKE 'Integration asset %'");
        if (usageBeforeAssetTests) {
          yield* client.query(
            `UPDATE usage_records
           SET uploads = $1, storage_bytes = $2, updated_at = now()
           WHERE org_id = '20000000-0000-4000-8000-000000000001'
             AND period = $3`,
            [usageBeforeAssetTests.uploads, usageBeforeAssetTests.storage_bytes, assetTestPeriod],
          );
        }
        yield* client.query("DELETE FROM organizations WHERE id = $1", [organizationActorOrgId]);
        yield* client.query("DELETE FROM organizations WHERE slug = $1", [lifecycleWorkspaceSlug]);
        yield* client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
          [
            personalActorUserId,
            organizationActorUserId,
            personalProvisionUserId,
            personalRecoveryUserId,
            lifecycleUserId,
            lifecycleMemberId,
          ],
        ]);
        yield* client.query("DELETE FROM outbox_events WHERE dedupe_key LIKE 'integration-%'");
        yield* client.query(
          `DELETE FROM outbox_events
         WHERE aggregate_id IN (
           '93000000-0000-4000-8000-000000000020',
           '93000000-0000-4000-8000-000000000021',
           '93000000-0000-4000-8000-000000000022'
         )`,
        );
        yield* client.query(
          `DELETE FROM operator_actions
         WHERE target_id IN (
           '93000000-0000-4000-8000-000000000020',
           '93000000-0000-4000-8000-000000000021',
           '93000000-0000-4000-8000-000000000022'
         )`,
        );
        yield* client.query(
          "DELETE FROM operator_action_locks WHERE idempotency_key LIKE 'integration-%'",
        );
        yield* client.query(
          `DELETE FROM distributions
         WHERE id IN (
           '93000000-0000-4000-8000-000000000020',
           '93000000-0000-4000-8000-000000000021',
           '93000000-0000-4000-8000-000000000022'
         )`,
        );
        yield* client.query(
          "DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'integration-%'",
        );
        yield* client.query(
          `DELETE FROM workspace_invitations
           WHERE token_hash = 'integration-actor-invitation-hash'
              OR email LIKE 'lifecycle-seat-%@meltiply.local'
              OR email LIKE 'lifecycle-delete-%@meltiply.local'`,
        );
        yield* client.query(
          `UPDATE comments
         SET reply_text = NULL,
             reply_status = 'none',
             reply_error = NULL,
             reply_attempted_at = NULL,
             updated_at = now()
         WHERE id = '80000000-0000-4000-8000-000000000001'`,
        );
        yield* client.query(
          "DELETE FROM distributions WHERE id IN ('60000000-0000-4000-8000-000000000009', '60000000-0000-4000-8000-000000000010')",
        );
        yield* client.query(
          `DELETE FROM outbox_events
           WHERE aggregate_id = '50000000-0000-4000-8000-000000000009'
             AND topic = 'channel.revocation.requested'`,
        );
        yield* client.query(
          "DELETE FROM platform_accounts WHERE id = '50000000-0000-4000-8000-000000000009'",
        );
        yield* client.query(
          "DELETE FROM platform_accounts WHERE platform_user_id = 'integration-oauth-user' OR platform_user_id LIKE 'integration-quota-%'",
        );
        yield* client.query("DELETE FROM platform_accounts WHERE id = ANY($1::uuid[])", [
          [alphaSecondAccountId, alphaThirdAccountId, alphaTiktokAccountId],
        ]);
        yield* client.query("DELETE FROM assets WHERE id = ANY($1::uuid[])", [
          [alphaSecondAssetId, alphaProcessingAssetId, alphaFailedAssetId],
        ]);
        // Composition fixtures are Post-owned, so the Posts are removed after
        // the rows that reference them: the cascade clears each attachment and
        // target. The seeded canonical Post still holds the shared Asset, so its
        // orphan clock stays clear.
        yield* client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [
          Object.values(fixturePostIds),
        ]);
      }),
    );
    await authenticatedPoolFor(env).end();
    await systemPoolFor(env).end();
  });

  it("binds the first verified identity to the installation without granting a workspace", async () => {
    // Better Auth owns the identity row; actor resolution binds the internal
    // user. Without an invitation, no shared Workspace membership is created.
    await systemTransaction(env, (client) =>
      client.query(
        `INSERT INTO "user" (id, name, email, "emailVerified")
         VALUES ($1, 'Actor Personal', 'actor-personal@meltiply.local', TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [personalActorUserId],
      ),
    );
    const actorIdentity = jwtIdentity({
      email: "actor-personal@meltiply.local",
      id: personalActorUserId,
      name: "Actor Personal",
    });

    await expect(resolveActor(env, actorIdentity, actorRequest())).rejects.toMatchObject({
      code: "workspace_membership_required",
      status: 403,
    });

    const identity = await systemTransaction(env, (client) =>
      client.query<{ membership_count: string; user_count: string }>(
        `SELECT COUNT(DISTINCT u.id)::text AS user_count,
                COUNT(DISTINCT om.id)::text AS membership_count
         FROM users u
         LEFT JOIN org_members om ON om.user_id = u.id
         WHERE u.auth_user_id = $1`,
        [personalActorUserId],
      ),
    );
    expect(identity.rows).toEqual([{ membership_count: "0", user_count: "0" }]);
  });

  it("resolves the seeded shared workspace and rejects a non-shared selection", async () => {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `INSERT INTO "user" (id, name, email, "emailVerified")
           VALUES ($1, 'Actor Organization', 'actor-organization@meltiply.local', TRUE)
           ON CONFLICT (id) DO NOTHING`,
          [organizationActorUserId],
        );
        yield* client.query(
          `INSERT INTO users (auth_user_id, email)
           VALUES ($1, 'actor-organization@meltiply.local')
           ON CONFLICT (auth_user_id) DO NOTHING`,
          [organizationActorUserId],
        );
      }),
    );
    const actorIdentity = jwtIdentity({
      email: "actor-organization@meltiply.local",
      id: organizationActorUserId,
      name: "Actor Organization",
    });
    const provisioned = await resolveActor(env, actorIdentity, actorRequest()).catch(
      (cause: unknown) => cause,
    );
    expect(provisioned).toMatchObject({
      code: "workspace_membership_required",
      status: 403,
    });

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const user = yield* client.query<{ id: string }>(
          "SELECT id FROM users WHERE auth_user_id = $1",
          [organizationActorUserId],
        );
        yield* client.query(
          `INSERT INTO org_members (org_id, user_id, role)
           VALUES ('20000000-0000-4000-8000-000000000005', $1, 'editor')
           ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'editor'`,
          [user.rows[0]!.id],
        );
      }),
    );

    const first = await resolveActor(env, actorIdentity, actorRequest());
    const second = await resolveActor(env, actorIdentity, actorRequest());
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      claims: {
        organizationId: "20000000-0000-4000-8000-000000000005",
        organizationRole: "editor",
        subject: organizationActorUserId,
      },
      role: "editor",
      workspace: { id: "20000000-0000-4000-8000-000000000005" },
    });

    await expect(
      resolveActor(env, actorIdentity, actorRequest({ "x-workspace-id": organizationActorOrgId })),
    ).rejects.toMatchObject({ code: "workspace_forbidden", status: 403 });

    await systemTransaction(env, (client) =>
      client.query("DELETE FROM users WHERE auth_user_id = $1", [organizationActorUserId]),
    );
  });

  it("accepts a pending invitation on the first authenticated request", async () => {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `INSERT INTO "user" (id, name, email, "emailVerified")
           VALUES ($1, 'Personal Provision', 'personal-provision@meltiply.local', TRUE)
           ON CONFLICT (id) DO NOTHING`,
          [personalProvisionUserId],
        );
        yield* client.query(
          `DELETE FROM workspace_invitations
           WHERE token_hash = 'integration-actor-invitation-hash'
              OR email = 'personal-provision@meltiply.local'`,
        );
        yield* client.query(
          `INSERT INTO workspace_invitations
             (org_id, email, role, invited_by, token_hash, expires_at)
           VALUES (
             '20000000-0000-4000-8000-000000000005',
             'personal-provision@meltiply.local',
             'editor',
             '10000000-0000-4000-8000-000000000001',
             'integration-actor-invitation-hash',
             now() + interval '7 days'
           )`,
        );
      }),
    );
    const actorIdentity = jwtIdentity({
      email: "personal-provision@meltiply.local",
      id: personalProvisionUserId,
      name: "Personal Provision",
    });

    const actor = await resolveActor(env, actorIdentity, actorRequest());
    expect(actor).toMatchObject({
      role: "editor",
      workspace: { id: "20000000-0000-4000-8000-000000000005" },
    });

    const accepted = await systemTransaction(env, (client) =>
      client.query<{ accepted: boolean; membership_count: string }>(
        `SELECT
           (SELECT accepted_at IS NOT NULL FROM workspace_invitations
             WHERE token_hash = 'integration-actor-invitation-hash') AS accepted,
           (SELECT count(*)::text FROM org_members om
             JOIN users u ON u.id = om.user_id
             WHERE u.auth_user_id = $1
               AND om.org_id = '20000000-0000-4000-8000-000000000005') AS membership_count`,
        [personalProvisionUserId],
      ),
    );
    expect(accepted.rows).toEqual([{ accepted: true, membership_count: "1" }]);

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query("DELETE FROM users WHERE auth_user_id = $1", [personalProvisionUserId]);
        yield* client.query(
          "DELETE FROM workspace_invitations WHERE token_hash = 'integration-actor-invitation-hash'",
        );
      }),
    );
  });

  it("lists platform accounts only for the authenticated tenant", async () => {
    const alphaAccounts = await Effect.runPromise(service.listPlatformAccounts(env, alpha));
    // The Post scenarios seed three extra Channels into the same workspace, so
    // isolation is asserted by the exact set Alpha owns plus tenant scoping on
    // every row, rather than by a row total that only held before composition
    // fixtures existed. Beta still sees nothing.
    expect(
      alphaAccounts
        .map((account) => account.platform_user_id)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      "integration-post-secondary",
      "integration-post-tertiary",
      "integration-post-tiktok",
      "local-youtube-alpha",
    ]);
    expect(
      alphaAccounts.every(
        (account) =>
          account.org_id === "20000000-0000-4000-8000-000000000001" &&
          account.brand_profile_id === alphaBrandProfileId,
      ),
    ).toBe(true);
    expect(
      alphaAccounts.find((account) => account.platform_user_id === "local-youtube-alpha"),
    ).toMatchObject({
      connection_status: "connected",
      org_id: "20000000-0000-4000-8000-000000000001",
      platform: "youtube",
    });
    expect(alphaAccounts.every((account) => account.capabilities.connect_available === false)).toBe(
      true,
    );

    await expect(Effect.runPromise(service.listPlatformAccounts(env, beta))).resolves.toEqual([]);
  });

  it("denies every alpha-owned mutation target from the beta tenant", async () => {
    const alphaAssetId = "40000000-0000-4000-8000-000000000001";
    const alphaAccountId = "50000000-0000-4000-8000-000000000001";
    const alphaDistributionId = "60000000-0000-4000-8000-000000000001";
    const alphaCommentId = "80000000-0000-4000-8000-000000000001";
    const alphaPostId = "48000000-0000-4000-8000-000000000001";
    const asset = assetServiceHarness([]).service;
    const distribution = distributionServiceWith();
    const posts = postServiceWith("youtube");
    const crossTenantCases: Array<{
      expectedStatus: number;
      name: string;
      run: () => Promise<unknown>;
    }> = [
      {
        expectedStatus: 404,
        name: "asset read",
        run: () => Effect.runPromise(asset.getAsset(env, beta, alphaAssetId)),
      },
      {
        expectedStatus: 404,
        name: "asset download URL",
        run: () => Effect.runPromise(asset.getAssetDownloadUrl(env, beta, alphaAssetId)),
      },
      {
        expectedStatus: 404,
        name: "asset preview URL",
        run: () => Effect.runPromise(asset.getAssetPreviewUrl(env, beta, alphaAssetId)),
      },
      {
        expectedStatus: 404,
        name: "post read",
        run: () => Effect.runPromise(posts.getPost(env, beta, alphaPostId)),
      },
      {
        expectedStatus: 404,
        name: "post draft save",
        run: () =>
          Effect.runPromise(
            posts.updatePost(
              env,
              beta,
              alphaPostId,
              {
                brandProfileId: betaBrandProfileId,
                defaultText: "Cross-tenant attempt",
              },
              "integration-cross-tenant-save-post",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "post scheduling",
        run: () =>
          Effect.runPromise(
            posts.schedulePost(
              env,
              beta,
              alphaPostId,
              {
                brandProfileId: betaBrandProfileId,
                scheduledAt: null,
                targets: [{ platformAccountId: alphaAccountId }],
              },
              "integration-cross-tenant-schedule-post",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "post deletion",
        run: () =>
          Effect.runPromise(
            posts.deletePost(
              env,
              beta,
              alphaPostId,
              { brandProfileId: alphaBrandProfileId },
              "integration-cross-tenant-delete-post",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "distribution read",
        run: () => Effect.runPromise(distribution.getDistribution(env, beta, alphaDistributionId)),
      },
      {
        expectedStatus: 404,
        name: "distribution analytics",
        run: () =>
          Effect.runPromise(
            distribution.distributionAnalytics(env, beta, alphaDistributionId, {
              limit: 20,
            }),
          ),
      },
      {
        expectedStatus: 404,
        name: "distribution update",
        run: () =>
          Effect.runPromise(
            distribution.updateDistribution(
              env,
              beta,
              alphaDistributionId,
              { titleOverride: "Cross-tenant attempt" },
              "integration-cross-tenant-update-distribution",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "distribution cancellation",
        run: () =>
          Effect.runPromise(
            distribution.cancelDistribution(
              env,
              beta,
              alphaDistributionId,
              "integration-cross-tenant-cancel-distribution",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "distribution retry",
        run: () =>
          Effect.runPromise(
            distribution.retryDistribution(
              env,
              beta,
              alphaDistributionId,
              "integration-cross-tenant-retry-distribution",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "platform disconnect",
        run: () =>
          Effect.runPromise(
            service.disconnectPlatform(
              env,
              beta,
              alphaAccountId,
              "integration-cross-tenant-disconnect-platform",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "comment reply",
        run: () =>
          Effect.runPromise(
            service.replyToComment(
              env,
              beta,
              alphaCommentId,
              betaBrandProfileId,
              "Cross-tenant reply",
              "integration-cross-tenant-reply",
            ),
          ),
      },
      {
        expectedStatus: 404,
        name: "publishing requirements",
        run: () =>
          getPublicationRequirements(
            env,
            beta,
            alphaAccountId,
            "integration-cross-tenant-requirements",
            new ProviderRegistry(),
          ),
      },
    ];

    try {
      for (const testCase of crossTenantCases) {
        await expect(testCase.run(), testCase.name).rejects.toMatchObject({
          status: testCase.expectedStatus,
        });
      }

      const betaPost = await Effect.runPromise(
        posts.createPost(
          env,
          beta,
          {
            brandProfileId: betaBrandProfileId,
            defaultText: "A beta-owned post must never be inserted for alpha.",
            title: "Integration cross-tenant beta post",
          },
          "integration-cross-tenant-create-post",
        ),
      );
      expect(betaPost.value.org_id).toBe("20000000-0000-4000-8000-000000000002");

      await expect(
        revokeOAuthConnection(env, beta, alphaAccountId, new ProviderRegistry()),
      ).resolves.toBeUndefined();

      const rows = await systemTransaction(env, (client) =>
        client.query<{
          alpha_post_count: string;
          asset_status: string;
          comment_reply_status: string;
          distribution_status: string;
          platform_account_count: string;
        }>(
          `SELECT
             (SELECT status FROM assets WHERE id = $1) AS asset_status,
             (SELECT reply_status FROM comments WHERE id = $2) AS comment_reply_status,
             (SELECT status FROM distributions WHERE id = $3) AS distribution_status,
             (SELECT COUNT(*)::text FROM platform_accounts WHERE id = $4) AS platform_account_count,
             (SELECT COUNT(*)::text FROM posts WHERE id = $5) AS alpha_post_count`,
          [alphaAssetId, alphaCommentId, alphaDistributionId, alphaAccountId, alphaPostId],
        ),
      );
      expect(rows.rows[0]).toEqual({
        alpha_post_count: "1",
        asset_status: "ready",
        comment_reply_status: "none",
        distribution_status: "published",
        platform_account_count: "1",
      });
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            "DELETE FROM posts WHERE title = 'Integration cross-tenant beta post'",
          );
          yield* client.query(
            "DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'integration-cross-tenant-%'",
          );
        }),
      );
    }
  });

  it("resolves ambiguous distributions through an idempotent operator audit", async () => {
    const publishedId = "93000000-0000-4000-8000-000000000020";
    const failedId = "93000000-0000-4000-8000-000000000021";
    const cancelledId = "93000000-0000-4000-8000-000000000022";
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        // One Post/account pair owns exactly one Distribution row, so each
        // ambiguous outcome this spec reconciles needs its own Post. They share
        // the seeded Asset the way real Posts do; the seeded canonical Post still
        // retains that Asset, so no orphan clock is started.
        yield* insertFixturePost(client, {
          accountId: alphaYoutubeAccountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.auditPublished,
          title: "Integration operator published",
        });
        yield* insertFixturePost(client, {
          accountId: alphaYoutubeAccountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.auditFailed,
          title: "Integration operator failed",
        });
        yield* insertFixturePost(client, {
          accountId: alphaYoutubeAccountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.auditCancelled,
          title: "Integration operator cancelled",
        });
        yield* client.query(
          `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attachment_ids,
            provider_operation_id, failure_code, failure_retryable,
            error_message, created_at)
         VALUES
           ($1, '20000000-0000-4000-8000-000000000001',
            '${alphaBrandProfileId}', $4,
            '50000000-0000-4000-8000-000000000001', 'youtube',
            'needs_reconciliation', ARRAY[$7::uuid],
            'publish-operation-20',
            'provider_outcome_ambiguous', false,
            'The provider outcome requires reconciliation.',
            '2030-01-01T00:00:00Z'),
           ($2, '20000000-0000-4000-8000-000000000001',
            '${alphaBrandProfileId}', $5,
            '50000000-0000-4000-8000-000000000001', 'youtube',
            'needs_reconciliation', ARRAY[$7::uuid],
            'publish-operation-21',
            'provider_outcome_ambiguous', false,
            'The provider outcome requires reconciliation.',
            '2030-01-01T00:00:00Z'),
           ($3, '20000000-0000-4000-8000-000000000001',
            '${alphaBrandProfileId}', $6,
            '50000000-0000-4000-8000-000000000001', 'youtube',
            'needs_reconciliation', ARRAY[$7::uuid],
            'publish-operation-22',
            'provider_cancel_failed', false,
            'The provider outcome requires reconciliation.',
            '2030-01-01T00:00:00Z')`,
          [
            publishedId,
            failedId,
            cancelledId,
            fixturePostIds.auditPublished,
            fixturePostIds.auditFailed,
            fixturePostIds.auditCancelled,
            alphaAssetId,
          ],
        );
        yield* client.query(
          `INSERT INTO provider_operations
           (org_id, distribution_id, operation, idempotency_key, status,
            created_at, updated_at)
         VALUES
           ('20000000-0000-4000-8000-000000000001', $1, 'cancel',
            'operator-cancel-22-old', 'needs_reconciliation',
            '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
           ('20000000-0000-4000-8000-000000000001', $1, 'cancel',
            'operator-cancel-22-latest', 'failed',
            '2030-01-02T00:00:00Z', '2030-01-02T00:00:00Z')`,
          [cancelledId],
        );
      }),
    );
    const operator = createOperatorReconciliationService();
    const actor = {
      email: "operator@example.test",
      subject: "access-operator-1",
    };
    const publishedInput = {
      failureCode: null,
      providerPostId: "post-20",
      providerUrl: "https://provider.example/posts/20",
      reason: "INC-200 provider dashboard confirmed publication",
      resolution: "published" as const,
      retryable: false,
    };

    const concurrentResults = await Promise.all([
      Effect.runPromise(
        operator.resolveDistribution(
          env,
          actor,
          publishedId,
          publishedInput,
          "integration-operator-published",
          "request-operator-published",
        ),
      ),
      Effect.runPromise(
        operator.resolveDistribution(
          env,
          actor,
          publishedId,
          publishedInput,
          "integration-operator-published",
          "request-operator-replay",
        ),
      ),
    ]);
    expect(concurrentResults.map((result) => result.replayed).sort()).toEqual([false, true]);
    const published = concurrentResults.find((result) => !result.replayed)!;
    const replayed = concurrentResults.find((result) => result.replayed)!;
    expect(replayed).toEqual({ ...published, replayed: true });
    await expect(
      Effect.runPromise(
        operator.resolveDistribution(
          env,
          actor,
          failedId,
          {
            ...publishedInput,
            providerPostId: "different-post",
          },
          "integration-operator-published",
          "request-operator-conflict",
        ),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    await Effect.runPromise(
      operator.resolveDistribution(
        env,
        actor,
        failedId,
        {
          failureCode: "provider_confirmed_failure",
          providerPostId: null,
          providerUrl: null,
          reason: "INC-201 provider dashboard confirmed no publication",
          resolution: "failed",
          retryable: true,
        },
        "integration-operator-failed",
        "request-operator-failed",
      ),
    );
    await expect(
      Effect.runPromise(
        service.retryDistribution(env, alpha, failedId, "integration-operator-retry"),
      ),
    ).resolves.toMatchObject({ value: { status: "queued" } });

    const cancelledInput = {
      failureCode: null,
      providerPostId: null,
      providerUrl: null,
      reason: "INC-202 provider dashboard confirmed cancellation",
      resolution: "cancelled" as const,
      retryable: false,
    };
    await expect(
      Effect.runPromise(
        operator.resolveDistribution(
          env,
          actor,
          cancelledId,
          cancelledInput,
          "integration-operator-cancelled-with-stale-evidence",
          "request-operator-cancelled-with-stale-evidence",
        ),
      ),
    ).rejects.toMatchObject({
      code: "cancellation_evidence_required",
      status: 409,
    });
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE provider_operations
         SET status = 'needs_reconciliation',
             updated_at = '2030-01-03T00:00:00Z'
         WHERE distribution_id = $1
           AND idempotency_key = 'operator-cancel-22-latest'`,
          [cancelledId],
        );
      }),
    );
    await Effect.runPromise(
      operator.resolveDistribution(
        env,
        actor,
        cancelledId,
        cancelledInput,
        "integration-operator-cancelled",
        "request-operator-cancelled",
      ),
    );

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE distributions
         SET published_at = '2030-01-01T00:00:00Z'
         WHERE id = $1`,
          [publishedId],
        );
        const distributions = yield* client.query<{
          id: string;
          platform_post_id: string | null;
          status: string;
        }>(
          `SELECT id, status, platform_post_id
         FROM distributions WHERE id IN ($1, $2, $3) ORDER BY id`,
          [publishedId, failedId, cancelledId],
        );
        expect(distributions.rows).toEqual([
          { id: publishedId, platform_post_id: "post-20", status: "published" },
          { id: failedId, platform_post_id: null, status: "queued" },
          { id: cancelledId, platform_post_id: null, status: "cancelled" },
        ]);
        const audits = yield* client.query<{
          actor_email: string;
          after_state: { status: string };
          before_state: { status: string };
          count: string;
        }>(
          `SELECT actor_email, before_state, after_state,
                COUNT(*) OVER ()::text AS count
         FROM operator_actions
         WHERE target_id IN ($1, $2, $3)
         ORDER BY target_id`,
          [publishedId, failedId, cancelledId],
        );
        expect(audits.rows).toHaveLength(3);
        expect(audits.rows[0]).toMatchObject({
          actor_email: "operator@example.test",
          after_state: { status: "published" },
          before_state: { status: "needs_reconciliation" },
          count: "3",
        });
      }),
    );
  });

  it("removes deleted Posts from Calendar while retaining published history", async () => {
    const postIds = [
      "4e000000-0000-4000-8000-000000000050",
      "4e000000-0000-4000-8000-000000000051",
    ];
    const publishedId = "93000000-0000-4000-8000-000000000050";
    const scheduledId = "93000000-0000-4000-8000-000000000051";
    const keys = postIds.map((id) => `integration-calendar-delete-${id}`);
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-31T23:59:59Z");
    const posts = createPostApiService();
    try {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          for (const postId of postIds) {
            yield* insertFixturePost(client, { postId, title: "Integration calendar deletion" });
          }
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform_account_id,
                platform, status, published_at, scheduled_at, platform_post_id)
             VALUES
               ($1, $3, $4, $5, $7, 'youtube', 'published',
                '2026-10-15T12:00:00Z', NULL, 'integration-calendar-published'),
               ($2, $3, $4, $6, $7, 'youtube', 'scheduled',
                NULL, '2026-10-16T12:00:00Z', NULL)`,
            [
              publishedId,
              scheduledId,
              alpha.organizationId,
              alphaBrandProfileId,
              postIds[0],
              postIds[1],
              alphaYoutubeAccountId,
            ],
          );
        }),
      );
      const before = await Effect.runPromise(service.calendar(env, alpha, start, end));
      expect(
        before.filter((event) => postIds.includes(event.post_id)).map((event) => event.id),
      ).toEqual([publishedId, scheduledId]);
      for (const [index, postId] of postIds.entries()) {
        await Effect.runPromise(
          posts.deletePost(
            env,
            alpha,
            postId,
            { brandProfileId: alphaBrandProfileId },
            keys[index]!,
          ),
        );
        await expect(Effect.runPromise(posts.getPost(env, alpha, postId))).rejects.toMatchObject({
          status: 404,
        });
      }
      const after = await Effect.runPromise(service.calendar(env, alpha, start, end));
      expect(after.filter((event) => postIds.includes(event.post_id))).toEqual([]);
      await expect(
        Effect.runPromise(service.distributionAnalytics(env, alpha, publishedId, { limit: 1 })),
      ).resolves.toEqual([]);
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM distributions WHERE post_id = ANY($1::uuid[])", [
            postIds,
          ]);
          yield* client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
          yield* client.query(
            "DELETE FROM idempotency_keys WHERE idempotency_key = ANY($1::text[])",
            [keys],
          );
        }),
      );
    }
  });

  it("batches latest published-Channel analytics without inventing measurements", async () => {
    const postIds = [
      "4e000000-0000-4000-8000-000000000060",
      "4e000000-0000-4000-8000-000000000061",
      "4e000000-0000-4000-8000-000000000062",
      "4e000000-0000-4000-8000-000000000063",
    ];
    const distributionIds = [
      "93000000-0000-4000-8000-000000000060",
      "93000000-0000-4000-8000-000000000061",
      "93000000-0000-4000-8000-000000000062",
      "93000000-0000-4000-8000-000000000063",
      "93000000-0000-4000-8000-000000000064",
    ];
    const posts = createPostApiService();
    try {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          for (const postId of postIds) {
            yield* insertFixturePost(client, { postId, title: "Integration Post analytics" });
          }
          yield* client.query("UPDATE posts SET status = 'draft' WHERE id = $1", [postIds[2]]);
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status, published_at, scheduled_at)
             VALUES
               ($1, $6, $7, $8, 'youtube', 'published', '2026-10-15T12:00:00Z', NULL),
               ($2, $6, $7, $8, 'tiktok', 'published', '2026-10-15T12:00:00Z', NULL),
               ($3, $6, $7, $8, 'threads', 'scheduled', NULL, '2026-10-16T12:00:00Z'),
               ($4, $6, $7, $9, 'youtube', 'published', '2026-10-15T12:00:00Z', NULL),
               ($5, $6, $7, $10, 'youtube', 'published', '2026-10-15T12:00:00Z', NULL)`,
            [
              ...distributionIds,
              alpha.organizationId,
              alphaBrandProfileId,
              postIds[0],
              postIds[1],
              postIds[3],
            ],
          );
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (distribution_id, org_id, likes, comments, shares, views, impressions, reach, snapshot_at)
             VALUES
               ($1, $5, 999, 999, 999, 999, 999, 999, '2026-10-15T12:00:00Z'),
               ($1, $5, 10, 0, 2, 200, 300, 100, '2026-10-15T13:00:00Z'),
               ($2, $5, 7, 2, 1, 10, 20, 8, '2026-10-15T13:00:00Z'),
               ($3, $5, 888, 888, 888, 888, 888, 888, '2026-10-15T13:00:00Z'),
               ($4, $5, 0, 0, 0, 0, 0, 0, '2026-10-15T13:00:00Z')`,
            [
              distributionIds[0],
              distributionIds[1],
              distributionIds[2],
              distributionIds[4],
              alpha.organizationId,
            ],
          );
        }),
      );
      const page = await Effect.runPromise(posts.listPosts(env, alpha, { limit: 100, offset: 0 }));
      expect(page.posts.find((post) => post.id === postIds[0])?.analytics).toEqual({
        likes: 17,
        comments: 2,
        shares: 3,
        saves: null,
        clicks: null,
        views: 210,
        impressions: 320,
        reach: 108,
      });
      expect(page.posts.find((post) => post.id === postIds[0])?.distribution_analytics).toEqual([
        {
          analytics: {
            likes: 7,
            comments: 2,
            shares: 1,
            saves: null,
            clicks: null,
            views: 10,
            impressions: 20,
            reach: 8,
          },
          distribution_id: distributionIds[1],
          platform: "tiktok",
        },
        {
          analytics: {
            likes: 10,
            comments: 0,
            shares: 2,
            saves: null,
            clicks: null,
            views: 200,
            impressions: 300,
            reach: 100,
          },
          distribution_id: distributionIds[0],
          platform: "youtube",
        },
      ]);
      expect(page.posts.find((post) => post.id === postIds[1])?.analytics).toBeNull();
      expect(page.posts.find((post) => post.id === postIds[1])?.distribution_analytics).toEqual([]);
      expect(page.posts.find((post) => post.id === postIds[2])?.analytics).toBeNull();
      expect(page.posts.find((post) => post.id === postIds[2])?.distribution_analytics).toEqual([]);
      expect(page.posts.find((post) => post.id === postIds[3])?.analytics).toEqual({
        likes: 0,
        comments: 0,
        shares: 0,
        saves: null,
        clicks: null,
        views: 0,
        impressions: 0,
        reach: 0,
      });
      expect(page.posts.find((post) => post.id === postIds[3])?.distribution_analytics).toEqual([
        {
          analytics: {
            likes: 0,
            comments: 0,
            shares: 0,
            saves: null,
            clicks: null,
            views: 0,
            impressions: 0,
            reach: 0,
          },
          distribution_id: distributionIds[4],
          platform: "youtube",
        },
      ]);
      await expect(Effect.runPromise(posts.getPost(env, beta, postIds[0]!))).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM distributions WHERE post_id = ANY($1::uuid[])", [
            postIds,
          ]);
          yield* client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
        }),
      );
    }
  });

  it("isolates calendar, analytics, and inbox reads across tenants", async () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-31T23:59:59Z");

    const alphaCalendar = await Effect.runPromise(service.calendar(env, alpha, start, end));
    expect(alphaCalendar).toHaveLength(1);
    // The calendar row carries the owning Post's identity and title, not the
    // legacy Asset fields, so the projection is asserted on post_id/post_title.
    expect(alphaCalendar[0]).toMatchObject({
      platform: "youtube",
      post_id: "48000000-0000-4000-8000-000000000001",
      post_title: "Alpha launch",
      status: "published",
    });
    await expect(Effect.runPromise(service.calendar(env, beta, start, end))).resolves.toEqual([]);

    const analyticsService = createCoreApiService(
      new ProviderRegistry()
        .capabilities()
        .map((capability) => ({ ...capability, analytics: capability.platform !== "youtube" })),
    );
    const analytics = await Effect.runPromise(
      analyticsService.summaryAnalytics(env, alpha, {
        end,
        start,
      }),
    );
    expect(analytics.totals).toMatchObject({
      comments: 9,
      likes: 84,
      post_count: 1,
      shares: 12,
      views: 1200,
    });
    expect(analytics.partial).toBe(true);
    // Coverage is derived from the Platforms actually published in scope, not
    // from every registered Platform. Alpha's only in-range publication is on
    // YouTube, which this fixture deliberately marks analytics-unsupported.
    expect(analytics.unsupported_platforms).toEqual(["youtube"]);
    expect(analytics.by_platform).toEqual([
      expect.objectContaining({
        last_synced_at: "2026-07-18T13:00:00.000Z",
        platform: "youtube",
        post_count: 1,
        views: 1200,
      }),
    ]);

    const inbox = await Effect.runPromise(
      service.inbox(env, alpha, {
        limit: 20,
        offset: 0,
      }),
    );
    expect(inbox.comments).toHaveLength(1);
    expect(inbox.comments[0]).toMatchObject({
      platform: "youtube",
      reply_status: "not_replied",
    });

    const alphaDistributions = await Effect.runPromise(
      service.listDistributions(env, alpha, {
        limit: 20,
        offset: 0,
      }),
    );
    expect(alphaDistributions.distributions.length).toBeGreaterThan(0);
    for (const distribution of alphaDistributions.distributions) {
      expect(distribution.org_id).toBe("20000000-0000-4000-8000-000000000001");
    }
    // Reading outcomes stays Post-scoped: one Post, one Brand Profile, and the
    // workspace aggregate are three different selections.
    const forPost = await Effect.runPromise(
      service.listDistributions(env, alpha, {
        limit: 20,
        offset: 0,
        postId: "48000000-0000-4000-8000-000000000001",
      }),
    );
    expect(forPost.distributions).toEqual([
      expect.objectContaining({
        post_id: "48000000-0000-4000-8000-000000000001",
      }),
    ]);
    const forProfile = await Effect.runPromise(
      service.listDistributions(env, alpha, {
        brandProfileId: alphaBrandProfileId,
        limit: 20,
        offset: 0,
      }),
    );
    expect(
      forProfile.distributions.every(
        ({ brand_profile_id }) => brand_profile_id === alphaBrandProfileId,
      ),
    ).toBe(true);
    await expect(
      Effect.runPromise(service.listDistributions(env, beta, { limit: 20, offset: 0 })),
    ).resolves.toEqual({
      distributions: [],
      has_more: false,
      limit: 20,
      offset: 0,
    });
    await expect(
      Effect.runPromise(service.inbox(env, beta, { limit: 20, offset: 0 })),
    ).resolves.toEqual({
      comments: [],
      has_more: false,
      limit: 20,
      offset: 0,
    });
  });

  it("summarizes only snapshots as of the range end and counts snapshotless posts", async () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const julyEnd = new Date("2026-07-31T23:59:59Z");
    const augustEnd = new Date("2026-08-31T23:59:59Z");
    const futureSnapshotId = "70000000-0000-4000-8000-000000000002";
    const snapshotlessId = "60000000-0000-4000-8000-000000000002";

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        // The snapshotless Post is a second retained Post for the seeded Asset,
        // which is exactly the shape that makes post_count rise while the
        // snapshot totals stay put.
        yield* insertFixturePost(client, {
          accountId: alphaYoutubeAccountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.snapshotless,
          title: "Integration snapshotless post",
        });
        yield* client.query(
          `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attachment_ids,
            published_at, platform_post_id, platform_url)
         VALUES (
           $1, '20000000-0000-4000-8000-000000000001',
           '${alphaBrandProfileId}', $2,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'published', ARRAY[$3::uuid],
           '2026-07-20T12:00:00Z',
           'local-post-alpha-2',
           'https://example.invalid/watch/local-post-alpha-2'
         )`,
          [snapshotlessId, fixturePostIds.snapshotless, alphaAssetId],
        );
        yield* client.query(
          `INSERT INTO analytics_snapshots
           (id, distribution_id, org_id, views, likes, comments, shares,
            watch_time_sec, reach, impressions, snapshot_at)
         VALUES (
           $1, $2,
           '20000000-0000-4000-8000-000000000001',
           9999, 9999, 9999, 9999, 9999, 9999, 9999,
           '2026-08-15T13:00:00Z'
         )`,
          [futureSnapshotId, snapshotlessId],
        );
      }),
    );

    try {
      // A snapshot beyond the range end stays invisible, while a published
      // post without any snapshot still counts toward post_count only.
      const july = await Effect.runPromise(
        service.summaryAnalytics(env, alpha, {
          end: julyEnd,
          start,
        }),
      );
      expect(july.totals).toMatchObject({
        comments: 9,
        likes: 84,
        post_count: 2,
        shares: 12,
        views: 1200,
      });
      expect(july.last_synced_at).toBe("2026-07-18T13:00:00.000Z");

      // Widening the range past the late snapshot admits exactly that one.
      const throughAugust = await Effect.runPromise(
        service.summaryAnalytics(env, alpha, {
          end: augustEnd,
          start,
        }),
      );
      expect(throughAugust.totals).toMatchObject({
        comments: 10_008,
        likes: 10_083,
        post_count: 2,
        shares: 10_011,
        views: 11_199,
      });
      expect(throughAugust.last_synced_at).toBe("2026-08-15T13:00:00.000Z");
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM analytics_snapshots WHERE id = $1", [futureSnapshotId]);
          yield* client.query("DELETE FROM distributions WHERE id = $1", [snapshotlessId]);
        }),
      );
    }
  });

  it("ranks the analytics Post cohort by stored metrics with honest coverage", async () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-31T23:59:59Z");
    // Mark only Instagram analytics-capable so coverage must exclude the
    // YouTube destination even though the shipped registry declares support.
    const analyticsService = createCoreApiService(
      new ProviderRegistry().capabilities().map((capability) => ({
        ...capability,
        analytics: capability.platform === "instagram",
      })),
    );
    const postIds = {
      mixed: "4f000000-0000-4000-8000-000000000070",
      unsupported: "4f000000-0000-4000-8000-000000000071",
      outside: "4f000000-0000-4000-8000-000000000072",
      awaiting: "4f000000-0000-4000-8000-000000000073",
    };
    const distributionIds = {
      mixedFirst: "96000000-0000-4000-8000-000000000070",
      mixedSecond: "96000000-0000-4000-8000-000000000071",
      unsupported: "96000000-0000-4000-8000-000000000072",
      outside: "96000000-0000-4000-8000-000000000073",
      awaiting: "96000000-0000-4000-8000-000000000074",
    };
    const excerptText = `  Launch   notes\n\n${"x".repeat(160)}`;
    const expectedExcerpt = ("Launch notes " + "x".repeat(160)).slice(0, 140);
    try {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          for (const [key, postId] of Object.entries(postIds)) {
            yield* insertFixturePost(client, {
              postId,
              title: key === "awaiting" ? "" : `Integration analytics ${key}`,
            });
          }
          yield* client.query("UPDATE posts SET default_text = $2 WHERE id = $1", [
            postIds.mixed,
            excerptText,
          ]);
          // `event_at` prefers `scheduled_at`, so the mixed and unsupported rows
          // would fall outside the calendar window while publishing inside it;
          // the outside row is the inverse. published_at must decide both.
          yield* client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform, status,
                published_at, scheduled_at, platform_post_id)
             VALUES
               ($1, $6, $7, $8, 'instagram', 'published',
                '2026-10-05T12:00:00Z', '2026-09-01T12:00:00Z', 'integration-analytics-a'),
               ($2, $6, $7, $8, 'instagram', 'published',
                '2026-10-06T12:00:00Z', '2026-09-02T12:00:00Z', 'integration-analytics-b'),
               ($3, $6, $7, $9, 'youtube', 'published',
                '2026-10-07T12:00:00Z', '2026-08-01T12:00:00Z', 'integration-analytics-c'),
               ($4, $6, $7, $10, 'tiktok', 'published',
                '2026-11-15T12:00:00Z', '2026-10-10T12:00:00Z', 'integration-analytics-d'),
               ($5, $6, $7, $11, 'instagram', 'published',
                '2026-10-08T12:00:00Z', NULL, 'integration-analytics-e')`,
            [
              distributionIds.mixedFirst,
              distributionIds.mixedSecond,
              distributionIds.unsupported,
              distributionIds.outside,
              distributionIds.awaiting,
              alpha.organizationId,
              alphaBrandProfileId,
              postIds.mixed,
              postIds.unsupported,
              postIds.outside,
              postIds.awaiting,
            ],
          );
          yield* client.query(
            `INSERT INTO analytics_snapshots
               (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
             VALUES
               ($1, $5, 100, 20, 2, 1, '2026-10-20T13:00:00Z'),
               ($2, $5, 50, 0, 1, 0, '2026-10-21T13:00:00Z'),
               ($3, $5, 5, 20, 0, 0, '2026-10-20T13:00:00Z'),
               ($4, $5, 777, 777, 777, 777, '2026-11-20T13:00:00Z'),
               ($1, $5, 9999, 9999, 9999, 9999, '2026-11-05T13:00:00Z')`,
            [
              distributionIds.mixedFirst,
              distributionIds.mixedSecond,
              distributionIds.unsupported,
              distributionIds.outside,
              alpha.organizationId,
            ],
          );
        }),
      );

      const summary = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { end, start }),
      );
      expect(summary.totals).toMatchObject({
        comments: 3,
        likes: 40,
        post_count: 4,
        shares: 1,
        views: 155,
      });
      expect(summary.last_synced_at).toBe("2026-10-21T13:00:00.000Z");
      expect(summary.unsupported_platforms).toEqual(["youtube"]);
      expect(summary.partial).toBe(true);
      expect(summary.by_platform).toEqual([
        expect.objectContaining({
          last_synced_at: "2026-10-21T13:00:00.000Z",
          platform: "instagram",
          post_count: 3,
          views: 150,
        }),
        expect.objectContaining({
          last_synced_at: "2026-10-20T13:00:00.000Z",
          platform: "youtube",
          post_count: 1,
          views: 5,
        }),
      ]);

      const instagramSummary = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { end, platform: "instagram", start }),
      );
      expect(instagramSummary.partial).toBe(false);
      expect(instagramSummary.unsupported_platforms).toEqual([]);

      const byMetric = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 10,
          metric: "views",
          offset: 0,
          start,
        }),
      );
      expect(byMetric.has_more).toBe(false);
      expect(byMetric.posts.map((post) => post.post_id)).toEqual([
        postIds.mixed,
        postIds.unsupported,
        postIds.awaiting,
      ]);
      expect(byMetric.posts[0]).toEqual({
        comments: 3,
        destination_count: 2,
        synced_destination_count: 2,
        excerpt: expectedExcerpt,
        last_synced_at: "2026-10-21T13:00:00.000Z",
        likes: 20,
        platforms: ["instagram"],
        post_id: postIds.mixed,
        published_at: "2026-10-05T12:00:00.000Z",
        shares: 1,
        title: "Integration analytics mixed",
        unsupported_platforms: [],
        views: 150,
      });
      expect(byMetric.posts[1]).toMatchObject({
        last_synced_at: "2026-10-20T13:00:00.000Z",
        platforms: ["youtube"],
        unsupported_platforms: ["youtube"],
        views: 5,
      });
      expect(byMetric.posts[2]).toMatchObject({
        destination_count: 1,
        synced_destination_count: 0,
        last_synced_at: null,
        platforms: ["instagram"],
        title: "",
        views: 0,
      });

      // Equal likes fall back to latest publication first, then Post id.
      const byLikes = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 10,
          metric: "likes",
          offset: 0,
          start,
        }),
      );
      expect(byLikes.posts.slice(0, 2).map((post) => post.post_id)).toEqual([
        postIds.unsupported,
        postIds.mixed,
      ]);

      const firstPage = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 2,
          metric: "views",
          offset: 0,
          start,
        }),
      );
      expect(firstPage.has_more).toBe(true);
      expect(firstPage.posts).toHaveLength(2);
      const secondPage = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 2,
          metric: "views",
          offset: 2,
          start,
        }),
      );
      expect(secondPage.has_more).toBe(false);
      expect(secondPage.posts.map((post) => post.post_id)).toEqual([postIds.awaiting]);

      const instagramOnly = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 10,
          metric: "views",
          offset: 0,
          platform: "instagram",
          start,
        }),
      );
      expect(instagramOnly.posts.map((post) => post.post_id)).toEqual([
        postIds.mixed,
        postIds.awaiting,
      ]);
      expect(instagramOnly.posts.every((post) => post.unsupported_platforms.length === 0)).toBe(
        true,
      );

      await expect(
        Effect.runPromise(
          analyticsService.analyticsPosts(env, alpha, {
            brandProfileId: betaBrandProfileId,
            end,
            limit: 10,
            metric: "views",
            offset: 0,
            start,
          }),
        ),
      ).resolves.toMatchObject({ has_more: false, posts: [] });
      await expect(
        Effect.runPromise(
          analyticsService.analyticsPosts(env, beta, {
            end,
            limit: 10,
            metric: "views",
            offset: 0,
            start,
          }),
        ),
      ).resolves.toMatchObject({ has_more: false, posts: [] });

      await systemTransaction(env, (client) =>
        client.query("UPDATE posts SET deleted_at = now() WHERE id = $1", [postIds.mixed]),
      );
      const afterPostDelete = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 10,
          metric: "views",
          offset: 0,
          start,
        }),
      );
      expect(afterPostDelete.posts.map((post) => post.post_id)).toEqual([
        postIds.unsupported,
        postIds.awaiting,
      ]);

      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE brand_profiles
           SET deleted_at = now(), purge_at = now() + INTERVAL '7 days'
           WHERE id = $1`,
          [alphaBrandProfileId],
        ),
      );
      try {
        const afterProfileDelete = await Effect.runPromise(
          analyticsService.analyticsPosts(env, alpha, {
            end,
            limit: 10,
            metric: "views",
            offset: 0,
            start,
          }),
        );
        expect(afterProfileDelete.posts).toEqual([]);
      } finally {
        await systemTransaction(env, (client) =>
          client.query(
            "UPDATE brand_profiles SET deleted_at = NULL, purge_at = NULL WHERE id = $1",
            [alphaBrandProfileId],
          ),
        );
      }
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM distributions WHERE post_id = ANY($1::uuid[])", [
            Object.values(postIds),
          ]);
          yield* client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [
            Object.values(postIds),
          ]);
        }),
      );
    }
  });

  it("treats every analytics-capable Provider as supported coverage", async () => {
    const start = new Date("2026-12-01T00:00:00Z");
    const end = new Date("2026-12-31T23:59:59Z");
    const postId = "4f000000-0000-4000-8000-000000000080";
    const platforms = ["facebook", "instagram", "threads", "tiktok", "youtube"] as const;
    const distributionIds = platforms.map(
      (_, index) => `97000000-0000-4000-8000-00000000008${index}`,
    );
    const analyticsService = createCoreApiService(
      new ProviderRegistry()
        .capabilities()
        .map((capability) => ({ ...capability, analytics: true })),
    );
    try {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* insertFixturePost(client, {
            postId,
            title: "Integration all-provider analytics",
          });
          for (const [index, platform] of platforms.entries()) {
            yield* client.query(
              `INSERT INTO distributions
                 (id, org_id, brand_profile_id, post_id, platform, status,
                  published_at, platform_post_id)
               VALUES ($1, $2, $3, $4, $5, 'published', '2026-12-10T12:00:00Z', $6)`,
              [
                distributionIds[index],
                alpha.organizationId,
                alphaBrandProfileId,
                postId,
                platform,
                `integration-all-providers-${platform}`,
              ],
            );
            yield* client.query(
              `INSERT INTO analytics_snapshots
                 (distribution_id, org_id, views, likes, comments, shares, snapshot_at)
               VALUES ($1, $2, 10, 1, 2, 3, '2026-12-20T12:00:00Z')`,
              [distributionIds[index], alpha.organizationId],
            );
          }
        }),
      );
      const summary = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { end, start }),
      );
      expect(summary.partial).toBe(false);
      expect(summary.unsupported_platforms).toEqual([]);
      expect(summary.by_platform.map((row) => row.platform)).toEqual([...platforms]);
      expect(summary.totals).toMatchObject({
        comments: 10,
        likes: 5,
        post_count: 5,
        shares: 15,
        views: 50,
      });
      const ranked = await Effect.runPromise(
        analyticsService.analyticsPosts(env, alpha, {
          end,
          limit: 10,
          metric: "views",
          offset: 0,
          start,
        }),
      );
      expect(ranked.posts).toHaveLength(1);
      expect(ranked.posts[0]).toMatchObject({
        destination_count: 5,
        synced_destination_count: 5,
        platforms: [...platforms],
        unsupported_platforms: [],
        views: 50,
      });
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM distributions WHERE post_id = $1", [postId]);
          yield* client.query("DELETE FROM posts WHERE id = $1", [postId]);
        }),
      );
    }
  });

  it("reuses an authorized analytics summary for thirty seconds without sliding or masking timestamps", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
      const first = await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range));
      expect(first.totals).toMatchObject({
        comments: 1,
        likes: 10,
        post_count: 1,
        shares: 2,
        views: 100,
      });
      expect(first.last_synced_at).toBe("2031-05-06T12:00:00.000Z");

      // A newer persisted snapshot must stay invisible inside the absolute
      // window: the second request returns the retained successful summary
      // instead of repeating the latest-snapshot aggregation.
      await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });
      clock.current = new Date("2031-06-01T00:00:10.000Z");
      const retained = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(retained.totals.views).toBe(100);
      expect(retained.last_synced_at).toBe("2031-05-06T12:00:00.000Z");

      // A hit at 29 seconds does not extend the 30-second absolute lifetime.
      clock.current = new Date("2031-06-01T00:00:29.000Z");
      await expect(
        Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range)),
      ).resolves.toMatchObject({ totals: { views: 100 } });

      clock.current = new Date("2031-06-01T00:00:31.000Z");
      const recomputed = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(recomputed.totals).toMatchObject({
        comments: 4,
        likes: 40,
        post_count: 1,
        shares: 8,
        views: 400,
      });
      expect(recomputed.last_synced_at).toBe("2031-05-07T12:00:00.000Z");
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("shares a cold authorized summary and releases follower transactions before waiting", async () => {
    const service = createCoreApiService();
    const pool = authenticatedPoolFor(env);
    // Observe only the Promise checkout used by authenticated transactions.
    const mutablePool = pool as unknown as { connect: () => Promise<TransactionClient> };
    const connect = mutablePool.connect;
    let releaseAggregation!: () => void;
    let aggregationStarted!: () => void;
    let followerCommitted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseAggregation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      aggregationStarted = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      followerCommitted = resolve;
    });
    let aggregations = 0;
    const running: Promise<unknown>[] = [];
    try {
      await seedAnalyticsCacheFixture();
      mutablePool.connect = async () => {
        const client = await connect.call(pool);
        const query: TransactionClient["query"] = async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(
          text: string,
          values?: readonly unknown[],
        ) => {
          if (text.includes("FROM analytics_snapshots s")) {
            aggregations += 1;
            aggregationStarted();
            await held;
          }
          const result = await client.query<Row>(text, values);
          if (text.trim() === "COMMIT") followerCommitted();
          return result;
        };
        return { query, release: () => client.release() };
      };
      const range = { start: analyticsCacheStart, end: analyticsCacheEnd };
      const first = Effect.runPromise(service.summaryAnalytics(env, alpha, range));
      running.push(first);
      await started;
      const second = Effect.runPromise(service.summaryAnalytics(env, alpha, range));
      running.push(second);
      await committed;
      expect(aggregations).toBe(1);
      releaseAggregation();
      const [leader, follower] = await Promise.all([first, second]);
      expect(leader.totals.views).toBe(100);
      expect(follower).toEqual(leader);
      leader.totals.views = 999;
      expect(follower.totals.views).toBe(100);
    } finally {
      releaseAggregation();
      await Promise.allSettled(running);
      mutablePool.connect = connect;
      await removeAnalyticsCacheFixture();
    }
  });

  it("partitions analytics cache entries across filters, profiles, identities, and capabilities", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
      const base = await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range));
      expect(base.totals.views).toBe(100);

      await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });
      const stillRetained = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(stillRetained.totals.views).toBe(100);

      const platformScoped = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { ...range, platform: "instagram" }),
      );
      expect(platformScoped.totals.views).toBe(400);
      const otherPlatform = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { ...range, platform: "youtube" }),
      );
      expect(otherPlatform.by_platform).toEqual([]);
      expect(otherPlatform.totals.views).toBe(0);

      const textFormat = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { ...range, format: "text" }),
      );
      expect(textFormat.totals.views).toBe(400);
      const videoFormat = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, { ...range, format: "video" }),
      );
      expect(videoFormat.by_platform).toEqual([]);

      const profileScoped = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, {
          ...range,
          brandProfileId: alphaBrandProfileId,
        }),
      );
      expect(profileScoped.totals.views).toBe(400);
      const accountScoped = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, {
          ...range,
          accountId: "94000000-0000-4000-8000-000000000099",
        }),
      );
      expect(accountScoped.by_platform).toEqual([]);

      // Another authorized identity in another Workspace must never inherit
      // Alpha's warm entry even with identical filters.
      const betaScoped = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, beta, range),
      );
      expect(betaScoped.by_platform).toEqual([]);
      expect(betaScoped.totals.views).toBe(0);

      const unsupportedService = createCoreApiService(
        new ProviderRegistry().capabilities().map((capability) => ({
          ...capability,
          analytics: capability.platform !== "instagram",
        })),
        { now: () => clock.current },
      );
      const unsupported = await Effect.runPromise(
        unsupportedService.summaryAnalytics(env, alpha, range),
      );
      expect(unsupported.totals.views).toBe(400);
      expect(unsupported.partial).toBe(true);
      expect(unsupported.unsupported_platforms).toEqual(["instagram"]);

      const baseAfterScopedReads = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(baseAfterScopedReads.totals.views).toBe(100);
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("invalidates a warm analytics entry when the active profile generation changes", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
      const warm = await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range));
      expect(warm.totals.views).toBe(100);
      await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });

      // Persisted lifecycle changes handled by any instance must alter the
      // applicable identity, even without deleting the profile.
      await systemTransaction(env, (client) =>
        client.query("UPDATE brand_profiles SET updated_at = now() WHERE id = $1", [
          alphaBrandProfileId,
        ]),
      );
      const recomputed = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(recomputed.totals.views).toBe(400);
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("derives cache identity from persisted Brand Profile lifecycle and re-authorizes every hit", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const firstInstance = createCoreApiService(undefined, { now: () => clock.current });
    const secondInstance = createCoreApiService(undefined, { now: () => clock.current });
    const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
    try {
      await seedAnalyticsCacheFixture();
      const warmAll = await Effect.runPromise(firstInstance.summaryAnalytics(env, alpha, range));
      const warmExplicit = await Effect.runPromise(
        firstInstance.summaryAnalytics(env, alpha, {
          ...range,
          brandProfileId: alphaBrandProfileId,
        }),
      );
      const warmSecondInstance = await Effect.runPromise(
        secondInstance.summaryAnalytics(env, alpha, range),
      );
      expect(warmAll.totals.views).toBe(100);
      expect(warmExplicit.totals.views).toBe(100);
      expect(warmSecondInstance.totals.views).toBe(100);

      // Simulate another API instance retiring the Profile after caches warmed.
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE brand_profiles
           SET deleted_at = now(), purge_at = now() + INTERVAL '7 days'
           WHERE id = $1`,
          [alphaBrandProfileId],
        ),
      );
      try {
        const hidden = await Effect.runPromise(firstInstance.summaryAnalytics(env, alpha, range));
        expect(hidden.by_platform).toEqual([]);
        expect(hidden.totals.views).toBe(0);
        const hiddenExplicit = await Effect.runPromise(
          firstInstance.summaryAnalytics(env, alpha, {
            ...range,
            brandProfileId: alphaBrandProfileId,
          }),
        );
        expect(hiddenExplicit.by_platform).toEqual([]);
        const hiddenSecondInstance = await Effect.runPromise(
          secondInstance.summaryAnalytics(env, alpha, range),
        );
        expect(hiddenSecondInstance.by_platform).toEqual([]);
      } finally {
        // Restoring elsewhere advances the persisted lifecycle generation, so
        // neither the pre-delete nor the hidden key can satisfy the next read.
        await systemTransaction(env, (client) =>
          client.query(
            `UPDATE brand_profiles
             SET deleted_at = NULL, purge_at = NULL, updated_at = now()
             WHERE id = $1`,
            [alphaBrandProfileId],
          ),
        );
      }

      const restored = await Effect.runPromise(firstInstance.summaryAnalytics(env, alpha, range));
      const restoredExplicit = await Effect.runPromise(
        firstInstance.summaryAnalytics(env, alpha, {
          ...range,
          brandProfileId: alphaBrandProfileId,
        }),
      );
      const restoredSecondInstance = await Effect.runPromise(
        secondInstance.summaryAnalytics(env, alpha, range),
      );
      expect(restored.totals.views).toBe(100);
      expect(restoredExplicit.totals.views).toBe(100);
      expect(restoredSecondInstance.totals.views).toBe(100);

      // Removing membership must fail even with every cache warm, and the
      // failure must not be retained or overwrite the successful entry.
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [
          alpha.organizationId,
          alpha.userId,
        ]),
      );
      try {
        await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });
        await expect(
          Effect.runPromise(firstInstance.summaryAnalytics(env, alpha, range)),
        ).rejects.toMatchObject({ code: "active_organization_required" });
      } finally {
        await systemTransaction(env, (client) =>
          client.query(
            `INSERT INTO org_members (org_id, user_id, role)
             VALUES ($1, $2, 'admin')
             ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`,
            [alpha.organizationId, alpha.userId],
          ),
        );
      }
      const afterReauthorization = await Effect.runPromise(
        firstInstance.summaryAnalytics(env, alpha, range),
      );
      expect(afterReauthorization.totals.views).toBe(100);
    } finally {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE brand_profiles
             SET deleted_at = NULL, purge_at = NULL
             WHERE id = $1 AND deleted_at IS NOT NULL`,
            [alphaBrandProfileId],
          );
          yield* client.query(
            `INSERT INTO org_members (org_id, user_id, role)
             VALUES ($1, $2, 'admin')
             ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`,
            [alpha.organizationId, alpha.userId],
          );
        }),
      );
      await removeAnalyticsCacheFixture();
    }
  });

  it("bounds retained analytics summaries to sixty-four entries and recomputes after eviction", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
      const warm = await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range));
      expect(warm.totals.views).toBe(100);
      await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });

      const emptyStart = Date.UTC(2024, 1, 1);
      for (let index = 0; index < 64; index += 1) {
        const start = new Date(emptyStart + index * 24 * 60 * 60 * 1_000);
        const end = new Date(start.getTime() + 60 * 60 * 1_000);
        await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, { end, start }));
      }

      // The 65th distinct entry evicted the warm fixture key, so the next read
      // must recompute instead of serving the pre-eviction value.
      const recomputed = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(recomputed.totals.views).toBe(400);
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("replaces the owned analytics cache when deployment configuration changes", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const range = { end: analyticsCacheEnd, start: analyticsCacheStart };
      const warm = await Effect.runPromise(analyticsService.summaryAnalytics(env, alpha, range));
      expect(warm.totals.views).toBe(100);
      await addAnalyticsCacheSnapshot({ comments: 4, likes: 40, shares: 8, views: 400 });

      // A different deployment configuration replaces the namespace and
      // recomputes from the authoritative rows instead of reusing the entry.
      const variantEnv = { ...env, VERSION: "1.0.0-target.1" };
      const variant = await Effect.runPromise(
        analyticsService.summaryAnalytics(variantEnv, alpha, range),
      );
      expect(variant.totals.views).toBe(400);

      // Returning to the original configuration replaces (not restores) the
      // previous namespace, so its old entry cannot reappear from the past.
      const replaced = await Effect.runPromise(
        analyticsService.summaryAnalytics(env, alpha, range),
      );
      expect(replaced.totals.views).toBe(400);
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("blocks a suspended member before a warm analytics cache can be reused", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    const sharedProfileId = "a0000000-0000-4000-8000-000000000091";
    try {
      const actor = await resolveActor(
        env,
        alphaIdentity,
        new Request("https://api.meltiply.test"),
      );
      await systemTransaction(env, (client) =>
        client.query(
          "INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, 'Suspension cache fixture', '#1d4ed8')",
          [sharedProfileId, actor.workspace.id],
        ),
      );
      await seedAnalyticsCacheFixture({
        organizationId: actor.workspace.id,
        brandProfileId: sharedProfileId,
      });
      const app = createApiApp({
        coreService: analyticsService,
        resolveActor,
        verifyJwtToken: async () => alphaIdentity,
      });
      const query = `brand_profile_id=${sharedProfileId}&start=${encodeURIComponent(analyticsCacheStart.toISOString())}&end=${encodeURIComponent(analyticsCacheEnd.toISOString())}`;
      const request = () =>
        app.request(
          `/api/v1/analytics?${query}`,
          { headers: { Authorization: bearerAuthorization } },
          env,
        );

      const warm = await request();
      expect(warm.status).toBe(200);
      expect(await warm.json()).toMatchObject({ totals: { views: 100 } });

      // Actor resolution runs on every request, so a warm cache cannot be
      // reached while the account is suspended.
      await systemTransaction(env, (client) =>
        client.query("UPDATE users SET suspended_at = now() WHERE id = $1", [alpha.userId]),
      );
      try {
        const blocked = await request();
        expect(blocked.status).toBe(403);
        expect(errorCodeFrom(await blocked.json())).toBe("account_suspended");
      } finally {
        await systemTransaction(env, (client) =>
          client.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [alpha.userId]),
        );
      }

      const resumed = await request();
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({ totals: { views: 100 } });
    } finally {
      await systemTransaction(env, (client) =>
        client.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [alpha.userId]),
      );
      await removeAnalyticsCacheFixture();
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM brand_profiles WHERE id = $1", [sharedProfileId]),
      );
    }
  });

  it("keeps request identity independent between cached analytics responses", async () => {
    const clock = { current: new Date("2031-06-01T00:00:00.000Z") };
    const analyticsService = createCoreApiService(undefined, { now: () => clock.current });
    try {
      await seedAnalyticsCacheFixture();
      const app = createApiApp({
        coreService: analyticsService,
        resolveActor: async () => alphaActor,
        verifyJwtToken: async () => alphaIdentity,
      });
      const query = `start=${encodeURIComponent(analyticsCacheStart.toISOString())}&end=${encodeURIComponent(analyticsCacheEnd.toISOString())}`;
      const request = () =>
        app.request(
          `/api/v1/analytics?${query}`,
          { headers: { Authorization: bearerAuthorization } },
          env,
        );

      const first = await request();
      const second = await request();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstRequestId = first.headers.get("X-Request-ID");
      const secondRequestId = second.headers.get("X-Request-ID");
      expect(firstRequestId).toBeTruthy();
      expect(secondRequestId).toBeTruthy();
      expect(secondRequestId).not.toBe(firstRequestId);
      await expect(first.json()).resolves.toEqual(await second.json());
    } finally {
      await removeAnalyticsCacheFixture();
    }
  });

  it("stores a publication instant for every published Distribution", async () => {
    const rows = await systemTransaction(env, (client) =>
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM distributions
         WHERE status = 'published' AND published_at IS NULL`,
      ),
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("returns not-found instead of exposing another tenant's distribution", async () => {
    await expect(
      Effect.runPromise(
        service.distributionAnalytics(env, beta, "60000000-0000-4000-8000-000000000001", {
          limit: 100,
        }),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("persists and filters replies that need reconciliation", async () => {
    await systemTransaction(env, (client) =>
      client.query(
        `UPDATE comments
         SET reply_status = 'needs_reconciliation', updated_at = now()
         WHERE id = '80000000-0000-4000-8000-000000000001'`,
      ),
    );

    try {
      const inbox = await Effect.runPromise(
        service.inbox(env, alpha, {
          limit: 20,
          offset: 0,
          replyStatus: "needs_reconciliation",
        }),
      );
      expect(inbox.comments).toHaveLength(1);
      expect(inbox.comments[0]?.reply_status).toBe("needs_reconciliation");
      await expect(
        Effect.runPromise(
          service.inbox(env, alpha, {
            limit: 20,
            offset: 0,
            replyStatus: "failed",
          }),
        ),
      ).resolves.toMatchObject({ comments: [], has_more: false });
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE comments
           SET reply_status = 'none', updated_at = now()
           WHERE id = '80000000-0000-4000-8000-000000000001'`,
        ),
      );
    }
  });

  // Second Alpha Asset used by multi-attachment composition scenarios. It is a
  // verified image with its own ready original object, so a Post attaching both
  // Assets can be scheduled once processing has produced publishable media.
  const alphaSecondAssetId = "94000000-0000-4000-8000-000000000001";
  // Alpha Assets that exist only in the scenarios that insert them, each pinned
  // to one lifecycle state so drafts and schedules can be told apart.
  const alphaProcessingAssetId = "94000000-0000-4000-8000-000000000002";
  const alphaFailedAssetId = "94000000-0000-4000-8000-000000000003";
  // Alpha Asset that exists only to carry the storage-quota padding object. It is
  // dedicated rather than reused because `idx_asset_objects_live_original` allows
  // at most one live original per Asset, and every shared fixture Asset already
  // owns its verified original.
  const alphaStoragePaddingAssetId = "94000000-0000-4000-8000-000000000004";
  const alphaSecondAccountId = "94000000-0000-4000-8000-000000000201";
  const alphaThirdAccountId = "94000000-0000-4000-8000-000000000202";
  const alphaYoutubeAccountId = "50000000-0000-4000-8000-000000000001";
  const alphaAssetId = "40000000-0000-4000-8000-000000000001";

  /**
   * Inserts the Assets, verified media, and Channels the Post scenarios share.
   *
   * The fixture state is the precondition each scenario asserts against: one
   * publishable image, one second publishable image for ordered multi-attachment
   * work, one Asset still processing with no verified media, one failed Asset,
   * two extra connected Channels beyond the seeded canonical YouTube
   * account — one Instagram and one Facebook, because a Brand Profile owns at
   * most one Channel per Provider — and one connected TikTok Channel. The
   * TikTok Channel exists because scheduling a
   * Post that carries TikTok provider options must resolve a real Channel of that
   * platform first; without it the scenario would stop at a 404 account lookup
   * instead of reaching the provider-option validation it is asserting. Inserting
   * them once keeps every scenario's own transaction focused on the composition
   * behavior it proves.
   */
  async function seedPostCompositionFixtures(): Promise<void> {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            status, original_filename, mime_type, finalized_at)
         VALUES
           ($1, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            '10000000-0000-4000-8000-000000000001', 'image',
            'Integration second asset', 'ready', 'second.png', 'image/png',
            now() - interval '1 day'),
           ($2, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            '10000000-0000-4000-8000-000000000001', 'image',
            'Integration processing asset', 'processing', 'processing.png',
            'image/png', NULL),
           ($3, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            '10000000-0000-4000-8000-000000000001', 'image',
            'Integration failed asset', 'failed', 'failed.png', 'image/png',
            now() - interval '1 day')`,
          [alphaSecondAssetId, alphaProcessingAssetId, alphaFailedAssetId],
        );
        yield* client.query(
          `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, width, height, status)
         VALUES
           ('20000000-0000-4000-8000-000000000001', $1, '${alphaBrandProfileId}',
            'original',
            'org/20000000-0000-4000-8000-000000000001/assets/' || $1::uuid::text || '/second.png',
            2048, 'image/png', 1080, 1080, 'ready')`,
          [alphaSecondAssetId],
        );
        yield* client.query(
          `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, object_id, status)
         SELECT object.org_id, object.asset_id, object.brand_profile_id,
                'original', object.id, 'ready'
           FROM asset_objects AS object
          WHERE object.asset_id = $1`,
          [alphaSecondAssetId],
        );
        yield* client.query(
          `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            display_name, access_token, scopes, metadata)
         VALUES
           ($1, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            'instagram', 'integration-post-secondary', 'Integration Channel 2',
            'integration-post-token-2', ARRAY['upload'], '{"fixture":true}'),
           ($2, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            'facebook', 'integration-post-tertiary', 'Integration Channel 3',
            'integration-post-token-3', ARRAY['upload'], '{"fixture":true}'),
           ($3, '20000000-0000-4000-8000-000000000001', '${alphaBrandProfileId}',
            'tiktok', 'integration-post-tiktok', 'Integration TikTok Channel',
            'integration-post-token-tiktok', ARRAY['video.publish'],
            '{"fixture":true}')`,
          [alphaSecondAccountId, alphaThirdAccountId, alphaTiktokAccountId],
        );
      }),
    );
  }

  /**
   * Reads the Alpha workspace's current monthly publication count.
   *
   * Quota scenarios manipulate the counter directly, so each one restores this
   * captured value afterwards instead of guessing at a fixture total.
   *
   * @returns Distributions recorded for the current usage period.
   */
  async function currentUsageCount(): Promise<number> {
    const rows = await systemTransaction(env, (client) =>
      client.query<{ distributions: string }>(
        `SELECT distributions::text
       FROM usage_records
       WHERE org_id = '20000000-0000-4000-8000-000000000001' AND period = $1`,
        [currentUsagePeriod],
      ),
    );
    return Number(rows.rows[0]?.distributions ?? 0);
  }

  /**
 * Restores the Alpha monthly publication counter.
 *
 * @param value - Distribution count captured before the scenario reserved work.
 @returns Resolves once the counter is written back.
 */
  function restoreUsageCount(value: number) {
    return systemTransaction(env, (client) =>
      client.query(
        `UPDATE usage_records
       SET distributions = $2, updated_at = now()
       WHERE org_id = '20000000-0000-4000-8000-000000000001' AND period = $1`,
        [currentUsagePeriod, value],
      ),
    );
  }

  /**
 * Removes the durable traces one Post scenario left behind.
 *
 * Publications, outbox commands, saved targets, and attachments are removed in
 * dependency order so the scenario's Posts disappear from every read surface,
 * and the idempotency records that reserved them go with them.
 *
 * @param postIds - Post identifiers the scenario created.
 @param keys - Idempotency keys the scenario used.
 @returns Resolves once the scenario left no durable state.
 */
  async function purgeIntegrationPosts(postIds: string[], keys: string[]): Promise<void> {
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const distributions = yield* client.query<{ id: string }>(
          "SELECT id FROM distributions WHERE post_id = ANY($1::uuid[])",
          [postIds],
        );
        const distributionIds = distributions.rows.map((row) => row.id);
        if (distributionIds.length > 0) {
          yield* client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
            distributionIds,
          ]);
          yield* client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
            distributionIds,
          ]);
        }
        yield* client.query("DELETE FROM post_attachments WHERE post_id = ANY($1::uuid[])", [
          postIds,
        ]);
        yield* client.query("DELETE FROM post_targets WHERE post_id = ANY($1::uuid[])", [postIds]);
        yield* client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [postIds]);
        yield* client.query(
          "DELETE FROM idempotency_keys WHERE idempotency_key = ANY($1::text[])",
          [keys],
        );
      }),
    );
  }

  /**
 * Creates an Alpha Post draft with the requested composition.
 *
 * Scenarios differ only in what they attach, what text they carry, and which
 * Channels they save, so the Brand Profile scope and a nonempty default body
 * are supplied here and only overridden where a scenario needs otherwise.
 *
 * @param posts - Post service driving the scenario.
 * @param input - Composition members the scenario wants stored.
 @param key - Idempotency key reserving this create.
 * @returns Effect resolving to the service's stored-response result.
 */
  function createAlphaPost(
    posts: PostApiService,
    input: {
      attachmentIds?: string[];
      defaultText?: string;
      targets?: PostTargetInput[];
      title?: string;
    },
    key: string,
  ) {
    return Effect.runPromise(
      posts.createPost(
        env,
        alpha,
        {
          brandProfileId: alphaBrandProfileId,
          defaultText: "Integration draft",
          ...input,
        },
        key,
      ),
    );
  }

  /**
   * Schedules an Alpha Post against the supplied Channels.
   * Supplies explicit public visibility and a not-made-for-kids fixture answer
   * for unrelated scenarios. Missing-answer cases call the service directly.
   *
   * @param posts - Post service driving the scenario.
   * @param postId - Post being scheduled.
   * @param targets - Channel targets the scenario publishes to.
   * @param scheduledAt - Deferred instant, or null to publish immediately.
   * @param key - Idempotency key reserving this schedule.
   * @returns Effect resolving to the service's stored-response result.
   */
  function scheduleAlphaPost(
    posts: PostApiService,
    postId: string,
    targets: PostTargetInput[],
    scheduledAt: Date | null,
    key: string,
  ) {
    return Effect.runPromise(
      posts.schedulePost(
        env,
        alpha,
        postId,
        {
          brandProfileId: alphaBrandProfileId,
          scheduledAt,
          targets: targets.map((target) =>
            target.platformAccountId === alphaYoutubeAccountId && !target.providerOptions
              ? {
                  ...target,
                  providerOptions: { youtube: { madeForKids: false, privacyStatus: "public" } },
                }
              : target,
          ),
        },
        key,
      ),
    );
  }
  // The composer owns one Post identity per composition: a text-only draft is
  // complete without any Channel, replaying the same key returns that same
  // identity, and reloading it returns the stored composition unchanged.
  it("creates a draft without Channels and reads it back after reload", async () => {
    const posts = postServiceWith("youtube");
    const created = await createAlphaPost(
      posts,
      { defaultText: "Reloadable draft", title: "Integration draft" },
      "integration-post-create",
    );
    const postId = created.value.id;
    let secondPostId: string | undefined;

    try {
      expect(created.replayed).toBe(false);
      expect(created.value).toMatchObject({
        analytics: null,
        attachments: [],
        brand_profile_id: alphaBrandProfileId,
        default_text: "Reloadable draft",
        distributions: [],
        // `revision` counts accepted edits, not the creation that produced the
        // row: `updatePostRowEffect` is the only writer that advances it (the
        // soft-delete path being the other), so a draft nobody has edited
        // reads back as 0 — the default `posts.revision` carries.
        revision: 0,
        status: "draft",
        targets: [],
      });

      // The same key replays the stored response instead of inserting again.
      const replay = await createAlphaPost(
        posts,
        { defaultText: "Reloadable draft", title: "Integration draft" },
        "integration-post-create",
      );
      expect(replay).toEqual({ ...created, replayed: true });
      // A distinct key is a genuinely distinct composition.
      const second = await createAlphaPost(
        posts,
        { defaultText: "Reloadable draft", title: "Integration draft" },
        "integration-post-create-second",
      );
      expect(second.value.id).not.toBe(postId);
      secondPostId = second.value.id;

      await expect(Effect.runPromise(posts.getPost(env, alpha, postId))).resolves.toEqual(
        created.value,
      );
      const listed = await Effect.runPromise(
        posts.listPosts(env, alpha, { limit: 100, offset: 0 }),
      );
      expect(listed.posts.map((post) => post.id)).toContain(postId);
      expect(listed.has_more).toBe(false);
      const draftsOnly = await Effect.runPromise(
        posts.listPosts(env, alpha, { limit: 100, offset: 0, status: "draft" }),
      );
      expect(draftsOnly.posts.map((post) => post.id)).toContain(postId);
      const activesOnly = await Effect.runPromise(
        posts.listPosts(env, alpha, {
          limit: 100,
          offset: 0,
          status: "active",
        }),
      );
      expect(activesOnly.posts.map((post) => post.id)).not.toContain(postId);
    } finally {
      await purgeIntegrationPosts(
        [postId, ...(secondPostId !== undefined ? [secondPostId] : [])],
        ["integration-post-create", "integration-post-create-second"],
      );
    }
  });

  // Authoring needs neither text nor media alone to be complete: media-only,
  // text-only, and multi-attachment Posts are all valid, and neither text nor
  // media together is not a Post at all.
  it("composes text-only, media-only, and ordered multi-attachment Posts", async () => {
    const posts = postServiceWith("youtube");
    const mediaOnly = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId, alphaSecondAssetId], defaultText: "" },
      "integration-post-media-only",
    );
    const textOnly = await createAlphaPost(
      posts,
      { defaultText: "Words only" },
      "integration-post-text-only",
    );
    const postIds = [mediaOnly.value.id, textOnly.value.id];

    try {
      expect(mediaOnly.value.attachments.map(({ asset_id }) => asset_id)).toEqual([
        alphaAssetId,
        alphaSecondAssetId,
      ]);
      expect(mediaOnly.value.default_text).toBe("");
      expect(textOnly.value.attachments).toEqual([]);
      expect(textOnly.value.default_text).toBe("Words only");

      // A save replaces the whole ordered set, so reorder and removal are one
      // atomic edit that never disturbs the caption.
      const reordered = await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          mediaOnly.value.id,
          {
            attachmentIds: [alphaSecondAssetId, alphaAssetId],
            brandProfileId: alphaBrandProfileId,
          },
          "integration-post-reorder",
        ),
      );
      expect(reordered.value.attachments.map(({ asset_id }) => asset_id)).toEqual([
        alphaSecondAssetId,
        alphaAssetId,
      ]);
      expect(reordered.value.attachments.map(({ position }) => position)).toEqual([0, 1]);
      // Creation is not an edit, so the reorder save is this Post's first
      // accepted edit: revision moves 0 -> 1 rather than 1 -> 2.
      expect(reordered.value.revision).toBe(1);
      expect(reordered.value.default_text).toBe("");

      const trimmed = await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          mediaOnly.value.id,
          {
            attachmentIds: [alphaAssetId],
            brandProfileId: alphaBrandProfileId,
          },
          "integration-post-trim",
        ),
      );
      expect(trimmed.value.attachments.map(({ asset_id }) => asset_id)).toEqual([alphaAssetId]);

      // The reload proves the stored order, not the response being echoed.
      await expect(
        Effect.runPromise(posts.getPost(env, alpha, mediaOnly.value.id)),
      ).resolves.toEqual(trimmed.value);

      await expect(
        createAlphaPost(posts, { attachmentIds: [], defaultText: "" }, "integration-post-empty"),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: "A post requires default_text or at least one attachment.",
        status: 422,
      });
      await expect(
        Effect.runPromise(
          posts.updatePost(
            env,
            alpha,
            textOnly.value.id,
            {
              attachmentIds: [],
              brandProfileId: alphaBrandProfileId,
              defaultText: "",
            },
            "integration-post-emptied",
          ),
        ),
      ).rejects.toMatchObject({ code: "validation_error", status: 422 });
    } finally {
      await purgeIntegrationPosts(postIds, [
        "integration-post-media-only",
        "integration-post-text-only",
        "integration-post-reorder",
        "integration-post-trim",
        "integration-post-empty",
        "integration-post-emptied",
      ]);
    }
  });

  // Media still being prepared is a legitimate draft reference: the composer
  // saves it so the creator can keep writing, and only scheduling refuses it.
  it("keeps processing and failed media as drafts but blocks publishing them", async () => {
    const posts = postServiceWith("youtube");
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaProcessingAssetId, alphaFailedAssetId],
        defaultText: "Draft while media prepares",
      },
      "integration-post-unready-draft",
    );
    const postId = draft.value.id;

    try {
      expect(draft.value.attachments.map(({ asset }) => asset.status)).toEqual([
        "processing",
        "failed",
      ]);
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [{ platformAccountId: alphaYoutubeAccountId }],
          null,
          "integration-post-unready-schedule",
        ),
      ).rejects.toMatchObject({
        code: "asset_not_ready",
        message: "One of the attachments has no verified media ready to publish.",
        status: 409,
      });
      const untouched = await Effect.runPromise(posts.getPost(env, alpha, postId));
      expect(untouched.status).toBe("draft");
      expect(untouched.distributions).toEqual([]);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        ["integration-post-unready-draft", "integration-post-unready-schedule"],
      );
    }
  });

  // Scheduling validates every affected Channel against the resolved caption,
  // media, and provider options before accepting anything, so a rejected
  // schedule reserves nothing and leaves the draft exactly as it was.
  it("rejects a schedule the platform capability cannot publish", async () => {
    const posts = postServiceWith("youtube", {
      max_caption_length: 4,
      max_hashtags: 1,
    });
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Far too long a caption" },
      "integration-post-caption-limit-draft",
    );
    const key = "integration-post-caption-limit";

    try {
      await expect(
        scheduleAlphaPost(
          posts,
          draft.value.id,
          [
            {
              hashtags: ["launch", "local"],
              platformAccountId: alphaYoutubeAccountId,
            },
          ],
          null,
          key,
        ),
      ).rejects.toMatchObject({
        code: "validation_error",
        details: [
          { code: "provider_caption_limit", field: "caption" },
          { code: "provider_hashtag_limit", field: "hashtags" },
        ],
        status: 422,
      });
      // The rejection rolls its transaction back, so nothing was reserved or
      // inserted and the same key stays usable.
      const reserved = await systemTransaction(env, (client) =>
        client.query<{ reservations: number }>(
          `SELECT COUNT(*)::int AS reservations
           FROM idempotency_keys
           WHERE idempotency_key = $1`,
          [key],
        ),
      );
      expect(reserved.rows[0]).toEqual({ reservations: 0 });
    } finally {
      await purgeIntegrationPosts([draft.value.id], ["integration-post-caption-limit-draft", key]);
    }
  });

  // One Post identity fans out to one Distribution per Channel, and only the
  // Channels that are still editable are created, updated, or cancelled.
  it("schedules many Channels once with atomic usage and outbox state", async () => {
    const posts = postServiceWith(["youtube", "instagram", "facebook"]);
    const period = currentUsagePeriod;
    const usageBefore = await currentUsageCount();
    // Exhaust a finite test allowance to prove quota refusal remains atomic.
    const distributionAllowance = COMMUNITY_LIMITS.max_distributions ?? 0;
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Many Channels" },
      "integration-post-multi-draft",
    );
    const postId = draft.value.id;
    const idempotencyKey = "integration-post-multi-schedule";
    const invalidKey = "integration-post-multi-schedule-invalid";
    const duplicateKey = "integration-post-multi-schedule-duplicate";
    const quotaKey = "integration-post-multi-schedule-quota";

    try {
      const scheduled = await scheduleAlphaPost(
        posts,
        postId,
        [
          { hashtags: ["primary"], platformAccountId: alphaYoutubeAccountId },
          {
            hashtags: ["secondary"],
            platformAccountId: alphaSecondAccountId,
          },
        ],
        null,
        idempotencyKey,
      );
      expect(scheduled.replayed).toBe(false);
      expect(scheduled.value.status).toBe("active");
      // `distributions` is unordered and its row ids are generated, so the rows
      // are keyed by the Channel that owns them before being compared.
      expect(
        scheduled.value.distributions
          .map(({ hashtags, platform_account_id }) => ({
            hashtags,
            platform_account_id,
          }))
          .sort((left, right) =>
            (left.platform_account_id ?? "").localeCompare(right.platform_account_id ?? ""),
          ),
      ).toEqual([
        { hashtags: ["primary"], platform_account_id: alphaYoutubeAccountId },
        { hashtags: ["secondary"], platform_account_id: alphaSecondAccountId },
      ]);
      expect(scheduled.value.distributions.every(({ post_id }) => post_id === postId)).toBe(true);

      // Replaying the same key returns the stored response and creates nothing.
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [
            { hashtags: ["primary"], platformAccountId: alphaYoutubeAccountId },
            {
              hashtags: ["secondary"],
              platformAccountId: alphaSecondAccountId,
            },
          ],
          null,
          idempotencyKey,
        ),
      ).resolves.toEqual({ ...scheduled, replayed: true });

      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [
            { platformAccountId: alphaYoutubeAccountId },
            { platformAccountId: "51000000-0000-4000-8000-000000000099" },
          ],
          null,
          invalidKey,
        ),
      ).rejects.toMatchObject({
        code: "platform_account_not_found",
        message: "The platform account was not found.",
        status: 404,
      });
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [
            { platformAccountId: alphaYoutubeAccountId },
            { platformAccountId: alphaYoutubeAccountId },
          ],
          null,
          duplicateKey,
        ),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: "targets must contain unique platform accounts.",
        status: 422,
      });

      // One Post/account pair carries one Distribution row: rescheduling the
      // same Channels edits those rows instead of adding duplicates.
      const distributionIds = scheduled.value.distributions.map(({ id }) => id);
      const durable = await systemTransaction(env, (client) =>
        client.query<{
          outbox_count: number | string;
          post_count: string;
          usage_distributions: string;
        }>(
          `SELECT
             (SELECT COUNT(*)::int FROM outbox_events
               WHERE aggregate_id = ANY($1::uuid[])
                 AND topic = 'distribution.publish.requested') AS outbox_count,
             (SELECT COUNT(*)::text FROM posts WHERE id = $2) AS post_count,
             (SELECT distributions::text FROM usage_records
               WHERE org_id = '20000000-0000-4000-8000-000000000001'
                 AND period = $3) AS usage_distributions`,
          [distributionIds, postId, period],
        ),
      );
      expect(durable.rows[0]).toEqual({
        outbox_count: 2,
        post_count: "1",
        usage_distributions: String(usageBefore + 2),
      });
      const invalidArtifacts = await systemTransaction(env, (client) =>
        client.query<{ count: number | string }>(
          `SELECT COUNT(*)::int AS count
           FROM idempotency_keys
           WHERE idempotency_key = ANY($1::text[])`,
          [[invalidKey, duplicateKey]],
        ),
      );
      expect(Number(invalidArtifacts.rows[0]?.count)).toBe(0);

      await restoreUsageCount(distributionAllowance);
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [{ platformAccountId: alphaThirdAccountId }],
          null,
          quotaKey,
        ),
      ).rejects.toMatchObject({
        code: "quota_exceeded",
        status: 403,
      });
      const quotaState = await systemTransaction(env, (client) =>
        client.query<{ distributions: string; idempotency_count: number }>(
          `SELECT distributions::text,
             (SELECT COUNT(*)::int FROM idempotency_keys WHERE idempotency_key = $2)
               AS idempotency_count
           FROM usage_records
           WHERE org_id = '20000000-0000-4000-8000-000000000001' AND period = $1`,
          [period, quotaKey],
        ),
      );
      expect(quotaState.rows[0]).toEqual({
        distributions: String(distributionAllowance),
        idempotency_count: 0,
      });

      const boundedPolicy = { ...COMMUNITY_LIMITS };
      try {
        const community = await vi.importActual<typeof Domain>("@meltiply/domain");
        Object.assign(COMMUNITY_LIMITS, community.COMMUNITY_LIMITS);
        const accepted = await scheduleAlphaPost(
          posts,
          postId,
          [{ platformAccountId: alphaThirdAccountId }],
          null,
          quotaKey,
        );
        expect(accepted.value.distributions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ platform_account_id: alphaThirdAccountId }),
          ]),
        );
        expect(await currentUsageCount()).toBe(distributionAllowance + 1);
        await expect(
          scheduleAlphaPost(
            posts,
            postId,
            [{ platformAccountId: alphaThirdAccountId }],
            null,
            quotaKey,
          ),
        ).resolves.toEqual({ ...accepted, replayed: true });
        expect(await currentUsageCount()).toBe(distributionAllowance + 1);
      } finally {
        Object.assign(COMMUNITY_LIMITS, boundedPolicy);
      }
    } finally {
      await purgeIntegrationPosts(
        [postId],
        ["integration-post-multi-draft", idempotencyKey, invalidKey, duplicateKey, quotaKey],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Removing a Channel from a schedule cancels only the work that has not been
  // claimed, while an outcome a provider already owns keeps its own lifecycle
  // and its published copy is never un-published locally.
  it("edits pending targets in place while leaving published history immutable", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Published then edited" },
      "integration-post-history-draft",
    );
    const postId = draft.value.id;

    try {
      const first = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }],
        null,
        "integration-post-history-first",
      );
      const publishedId = first.value.distributions[0]!.id;
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE distributions
           SET status = 'published', published_at = now(),
               platform_post_id = 'integration-published-1',
               platform_url = 'https://example.invalid/watch/integration-published-1',
               title_override = 'Published title', updated_at = now()
           WHERE id = $1`,
          [publishedId],
        ),
      );

      // The already-published Channel is left untouched while a new Channel is
      // added and a previously pending Channel would have been edited.
      const second = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        null,
        "integration-post-history-second",
      );
      // `distributions` is unordered: rows are keyed by their Channel, because
      // read order follows `event_at`, and the freshly added row is newer than
      // the published row it now sits beside.
      expect(
        second.value.distributions
          .map(({ platform_account_id, status, title_override }) => ({
            platform_account_id,
            status,
            title_override,
          }))
          .sort((left, right) =>
            (left.platform_account_id ?? "").localeCompare(right.platform_account_id ?? ""),
          ),
      ).toEqual([
        {
          platform_account_id: alphaYoutubeAccountId,
          status: "published",
          title_override: "Published title",
        },
        {
          platform_account_id: alphaSecondAccountId,
          status: "queued",
          title_override: null,
        },
      ]);
      const addedId = second.value.distributions.find(
        ({ platform_account_id }) => platform_account_id === alphaSecondAccountId,
      )!.id;
      // The same dropped Distribution can have retryable and leased delivery
      // attempts. Remove only pending/failed publish commands, never the
      // consumer-owned lease or a command for another topic.
      await systemTransaction(env, (client) =>
        client.query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload,
              state, lease_expires_at)
           SELECT $1::uuid, command.topic, 'distribution', $2::uuid,
                  command.dedupe_key, '{}'::jsonb, command.state,
                  CASE WHEN command.state = 'leased'
                       THEN now() + INTERVAL '5 minutes' END
           FROM (VALUES
             ('distribution.publish.requested', 'integration-drop-failed', 'failed'),
             ('distribution.publish.requested', 'integration-drop-leased', 'leased'),
             ('distribution.analytics.requested', 'integration-drop-other', 'pending')
           ) AS command(topic, dedupe_key, state)`,
          [alpha.organizationId, addedId],
        ),
      );

      // Dropping a Channel that is still queued cancels it and releases its
      // command, while the published row survives the same edit. A cancelled
      // outcome is a durable row, not a deletion: the Post keeps exactly one
      // Distribution per Channel, and the dropped Channel is never replaced by a
      // second row.
      const third = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }],
        null,
        "integration-post-history-third",
      );
      expect(
        third.value.distributions
          .map(({ platform_account_id, status }) => ({
            platform_account_id,
            status,
          }))
          .sort((left, right) =>
            (left.platform_account_id ?? "").localeCompare(right.platform_account_id ?? ""),
          ),
      ).toEqual([
        { platform_account_id: alphaYoutubeAccountId, status: "published" },
        { platform_account_id: alphaSecondAccountId, status: "cancelled" },
      ]);
      const commands = await systemTransaction(env, (client) =>
        client.query<{ aggregate_id: string; commands: string }>(
          `SELECT outbox.aggregate_id,
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id = outbox.aggregate_id
                 AND topic = 'distribution.publish.requested'
                 AND state IN ('pending', 'failed')) AS commands
           FROM (SELECT $1::uuid AS aggregate_id
                 UNION ALL SELECT $2::uuid) AS outbox`,
          [publishedId, addedId],
        ),
      );
      // Only the *dropped* Channel released its command. The published row's
      // original `distribution.publish.requested` command is still `pending`:
      // this fixture forces the publication with a direct UPDATE and no
      // consumer ever drains the outbox, so nothing deleted that command and
      // the count is 1 for it and 0 for the cancelled one.
      expect(commands.rows.map(({ commands: count }) => count).sort()).toEqual(["0", "1"]);
      const retained = await systemTransaction(env, (client) =>
        client.query<{ state: string; topic: string }>(
          `SELECT topic, state FROM outbox_events
           WHERE aggregate_id = $1 ORDER BY topic, state`,
          [addedId],
        ),
      );
      expect(retained.rows).toEqual([
        { state: "pending", topic: "distribution.analytics.requested" },
        { state: "leased", topic: "distribution.publish.requested" },
      ]);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-history-draft",
          "integration-post-history-first",
          "integration-post-history-second",
          "integration-post-history-third",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // A settled outcome is never revalidated: a published Channel whose
  // credential has since been revoked stays untouched while the still-pending
  // Channel reschedules, instead of the revoked Channel failing the whole
  // schedule.
  it("reschedules pending Channels when a settled Channel's credential lapsed", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaAssetId],
        defaultText: "Reschedule past a revoked Channel",
      },
      "integration-post-settled-draft",
    );
    const postId = draft.value.id;

    try {
      const first = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        null,
        "integration-post-settled-first",
      );
      const publishedId = distributionIdForChannel(first.value, alphaYoutubeAccountId);
      // The Channel's outcome is settled exactly the way a drained publish
      // command leaves it: a provider attempt exists, the row is published,
      // and only then does the credential lapse.
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE distributions
             SET status = 'published', published_at = now(),
                 platform_post_id = 'integration-settled-1',
                 platform_url = 'https://example.invalid/watch/integration-settled-1',
                 attempt_count = 1, last_attempt_at = now(), updated_at = now()
             WHERE id = $1`,
            [publishedId],
          );
          yield* client.query(
            `INSERT INTO provider_operations
             (org_id, distribution_id, operation, idempotency_key, status)
             VALUES
             ('20000000-0000-4000-8000-000000000001', $1, 'publish',
              'integration-settled-publish-1', 'succeeded')`,
            [publishedId],
          );
          yield* client.query(
            `UPDATE platform_accounts
             SET connection_status = 'revoked', revoked_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [alphaYoutubeAccountId],
          );
        }),
      );

      const rescheduledAt = new Date(Date.now() + 3_600_000);
      const rescheduled = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        rescheduledAt,
        "integration-post-settled-second",
      );
      const settled = rescheduled.value.distributions.find(
        ({ platform_account_id }) => platform_account_id === alphaYoutubeAccountId,
      );
      expect(settled).toMatchObject({
        id: publishedId,
        platform_post_id: "integration-settled-1",
        status: "published",
      });
      expect(settled?.scheduled_at).toBeNull();
      const pending = rescheduled.value.distributions.find(
        ({ platform_account_id }) => platform_account_id === alphaSecondAccountId,
      );
      expect(pending).toMatchObject({
        scheduled_at: rescheduledAt.toISOString(),
        status: "scheduled",
      });
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE platform_accounts
           SET connection_status = 'connected', revoked_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [alphaYoutubeAccountId],
        ),
      );
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-settled-draft",
          "integration-post-settled-first",
          "integration-post-settled-second",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Once an attempt has claimed a Channel its frozen snapshot is the only
  // answer to what that Channel published: editing the Post's text and
  // attachments afterwards changes neither the Post read nor the Distribution
  // read, and both surfaces expose the identical frozen publication.
  it("reads the frozen publication identically on Post and Distribution after edits", async () => {
    const posts = postServiceWith("youtube");
    const distributionService = distributionServiceWith();
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaAssetId],
        defaultText: "Original caption",
        title: "Frozen publication",
      },
      "integration-post-frozen-draft",
    );
    const postId = draft.value.id;

    try {
      const scheduled = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }],
        null,
        "integration-post-frozen-schedule",
      );
      const publishedId = distributionIdForChannel(scheduled.value, alphaYoutubeAccountId);
      // The snapshot is seeded the way a claimed attempt persists it: storage
      // internals ride along in the stored JSON but never reach the wire.
      const snapshot = {
        version: 1,
        post_id: postId,
        content: {
          title: "Frozen publication",
          text: "Original caption",
          hashtags: ["launch"],
        },
        media: [
          {
            position: 0,
            asset_id: alphaAssetId,
            asset_type: "image",
            rendition_id: null,
            object_id: "70000000-0000-4000-8000-000000000001",
            object_key: "org/20000000-0000-4000-8000-000000000001/assets/launch.png",
            content_type: "image/png",
            file_size: 2048,
            etag: "integration-etag-1",
            width: 1080,
            height: 1080,
            duration_sec: null,
          },
        ],
      };
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE distributions
             SET status = 'published', published_at = now(),
                 platform_post_id = 'integration-frozen-1',
                 platform_url = 'https://example.invalid/watch/integration-frozen-1',
                 attempt_count = 1, last_attempt_at = now(), updated_at = now()
             WHERE id = $1`,
            [publishedId],
          );
          yield* client.query(
            `INSERT INTO provider_operations
             (org_id, distribution_id, operation, idempotency_key, status,
              publication_snapshot)
             VALUES
             ('20000000-0000-4000-8000-000000000001', $1, 'publish',
              'integration-frozen-publish-1', 'succeeded', $2::jsonb)`,
            [publishedId, JSON.stringify(snapshot)],
          );
        }),
      );

      // Live composition state drifts away from the frozen copy on purpose.
      await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          {
            attachmentIds: [alphaSecondAssetId],
            brandProfileId: alphaBrandProfileId,
            defaultText: "Edited caption after publish",
            title: "Edited title",
          },
          "integration-post-frozen-edit",
        ),
      );

      const publication = {
        title: "Frozen publication",
        text: "Original caption",
        hashtags: ["launch"],
        provider_options: null,
        media: [
          {
            asset_id: alphaAssetId,
            asset_type: "image",
            content_type: "image/png",
            duration_sec: null,
            file_size: 2048,
            height: 1080,
            position: 0,
            width: 1080,
          },
        ],
      };
      const reloaded = await Effect.runPromise(posts.getPost(env, alpha, postId));
      expect(reloaded.default_text).toBe("Edited caption after publish");
      const embedded = reloaded.distributions.find(({ id }) => id === publishedId);
      expect(embedded).toMatchObject({
        publication,
        status: "published",
      });
      const direct = await Effect.runPromise(
        distributionService.getDistribution(env, alpha, publishedId),
      );
      expect(direct).toMatchObject({
        publication,
        status: "published",
      });
      expect(direct.publication).toEqual(embedded?.publication);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-frozen-draft",
          "integration-post-frozen-schedule",
          "integration-post-frozen-edit",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Rescheduling several Channels at once rewrites rows whose ordered
  // selections and hashtag sets all differ, so each row keeps its own values
  // and its own identity instead of a value borrowed from another Channel's
  // array position.
  it("reschedules Channels whose ordered selections and hashtags differ", async () => {
    // The fixture Platform publishes one attachment at a time by default, so
    // the capability is widened to accept a text-only target and a
    // multi-attachment one side by side.
    const posts = postServiceWith(["youtube", "instagram"], {
      max_media_count: 3,
      min_media_count: 0,
      multi_asset_types: ["image"],
    });
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaAssetId, alphaSecondAssetId],
        defaultText: "Rescheduled pair",
      },
      "integration-post-pair-draft",
    );
    const postId = draft.value.id;
    const project = (value: components["schemas"]["Post"]) =>
      value.distributions
        .map(({ hashtags, id, platform_account_id, status }) => ({
          hashtags,
          id,
          platform_account_id,
          status,
        }))
        // `distributions` is unordered and its row ids are generated, so rows are
        // keyed by the Channel that owns them; a nullable account sorts first and
        // only appears once a Channel-less row is in play.
        .sort((left, right) =>
          (left.platform_account_id ?? "").localeCompare(right.platform_account_id ?? ""),
        );

    try {
      const first = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [alphaAssetId],
            hashtags: ["primary", "shared"],
            platformAccountId: alphaYoutubeAccountId,
          },
          {
            attachmentIds: [alphaAssetId, alphaSecondAssetId],
            hashtags: ["secondary"],
            platformAccountId: alphaSecondAccountId,
            titleOverride: "First title",
          },
        ],
        null,
        "integration-post-pair-first",
      );
      const pair = project(first.value);
      expect(
        pair.map(({ hashtags, platform_account_id }) => ({
          hashtags,
          platform_account_id,
        })),
      ).toEqual([
        {
          hashtags: ["primary", "shared"],
          platform_account_id: alphaYoutubeAccountId,
        },
        { hashtags: ["secondary"], platform_account_id: alphaSecondAccountId },
      ]);

      // Both rows are pending, so the second schedule edits them in place. The
      // first Channel becomes a deliberate text-only target and the second
      // narrows its selection, which is the reverse length order of the first
      // schedule.
      const second = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [],
            hashtags: ["replacement"],
            platformAccountId: alphaYoutubeAccountId,
          },
          {
            attachmentIds: [alphaSecondAssetId],
            hashtags: ["narrowed", "second"],
            platformAccountId: alphaSecondAccountId,
            titleOverride: null,
          },
        ],
        null,
        "integration-post-pair-second",
      );
      expect(project(second.value)).toEqual([
        {
          hashtags: ["replacement"],
          id: pair[0]!.id,
          platform_account_id: alphaYoutubeAccountId,
          status: "queued",
        },
        {
          hashtags: ["narrowed", "second"],
          id: pair[1]!.id,
          platform_account_id: alphaSecondAccountId,
          status: "queued",
        },
      ]);
      expect(second.value.id).toBe(postId);
      expect(second.value.status).toBe("active");

      // The ordered selections reach the durable rows as written: an empty
      // array stays an empty array instead of collapsing to inherited media.
      const stored = await systemTransaction(env, (client) =>
        client.query<{
          attachment_ids: string[] | null;
          platform_account_id: string;
          title_override: string | null;
        }>(
          `SELECT platform_account_id, title_override, attachment_ids
             FROM distributions
            WHERE post_id = $1
            ORDER BY platform_account_id`,
          [postId],
        ),
      );
      expect(stored.rows).toEqual([
        {
          attachment_ids: [],
          platform_account_id: alphaYoutubeAccountId,
          title_override: null,
        },
        {
          attachment_ids: [alphaSecondAssetId],
          platform_account_id: alphaSecondAccountId,
          title_override: null,
        },
      ]);

      // The saved target set carries the same per-Channel choices, so a later
      // schedule that omits targets repeats this composition.
      const saved = await systemTransaction(env, (client) =>
        client.query<{
          attachment_ids: string[] | null;
          hashtags: string[] | null;
          platform_account_id: string;
        }>(
          `SELECT platform_account_id, hashtags, attachment_ids
             FROM post_targets
            WHERE post_id = $1
            ORDER BY platform_account_id`,
          [postId],
        ),
      );
      expect(saved.rows).toEqual([
        {
          attachment_ids: [],
          hashtags: ["replacement"],
          platform_account_id: alphaYoutubeAccountId,
        },
        {
          attachment_ids: [alphaSecondAssetId],
          hashtags: ["narrowed", "second"],
          platform_account_id: alphaSecondAccountId,
        },
      ]);

      // Each row keeps exactly one live command: the reschedule replaced the
      // previous intent instead of stacking a second command beside it.
      const commands = await systemTransaction(env, (client) =>
        client.query<{ commands: string; distribution_id: string }>(
          `SELECT distribution.id AS distribution_id,
                  (SELECT COUNT(*)::text FROM outbox_events
                    WHERE aggregate_id = distribution.id
                      AND topic = 'distribution.publish.requested'
                      AND state IN ('pending', 'failed')) AS commands
             FROM distributions AS distribution
            WHERE distribution.post_id = $1
            ORDER BY distribution.platform_account_id`,
          [postId],
        ),
      );
      expect(commands.rows).toEqual([
        { commands: "1", distribution_id: pair[0]!.id },
        { commands: "1", distribution_id: pair[1]!.id },
      ]);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-pair-draft",
          "integration-post-pair-first",
          "integration-post-pair-second",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Re-adding a Channel that an earlier schedule dropped reuses the row local
  // cancellation left behind: `(post_id, platform_account_id)` is unique, so
  // without revival the request would succeed while publishing nothing. A
  // Channel whose outcome a provider already owns keeps that outcome instead.
  it("revives a dropped Channel instead of succeeding without publishing", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaAssetId, alphaSecondAssetId],
        defaultText: "Dropped then readded",
      },
      "integration-post-readd-draft",
    );
    const postId = draft.value.id;
    const deferredAt = new Date(Date.now() + 7_200_000);
    const outcomes = (value: components["schemas"]["Post"]) =>
      value.distributions
        .map(({ id, platform_account_id, scheduled_at, status }) => ({
          id,
          platform_account_id,
          scheduled_at,
          status,
        }))
        // `distributions` is unordered and its row ids are generated, so rows are
        // keyed by the Channel that owns them instead of by their own identity.
        .sort((left, right) =>
          (left.platform_account_id ?? "").localeCompare(right.platform_account_id ?? ""),
        );

    try {
      const first = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [alphaAssetId],
            platformAccountId: alphaYoutubeAccountId,
          },
          {
            attachmentIds: [alphaSecondAssetId],
            platformAccountId: alphaSecondAccountId,
          },
        ],
        null,
        "integration-post-readd-first",
      );
      const ids = new Map(
        first.value.distributions.map((distribution) => [
          distribution.platform_account_id,
          distribution.id,
        ]),
      );
      const secondId = ids.get(alphaSecondAccountId)!;
      // One Channel reaches a provider, so the re-add that follows must leave
      // its published outcome alone.
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE distributions
              SET status = 'published', published_at = now(),
                  platform_post_id = 'integration-readd-published',
                  platform_url =
                    'https://example.invalid/watch/integration-readd-published',
                  attempt_count = attempt_count + 1, updated_at = now()
            WHERE id = $1`,
          [ids.get(alphaYoutubeAccountId)],
        ),
      );

      // Dropping the second Channel cancels its unclaimed row and releases its
      // command; the published row survives the same edit.
      await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [alphaAssetId],
            platformAccountId: alphaYoutubeAccountId,
          },
        ],
        null,
        "integration-post-readd-drop",
      );
      const dropped = await systemTransaction(env, (client) =>
        client.query<{ platform_account_id: string; status: string }>(
          `SELECT platform_account_id, status
             FROM distributions
            WHERE post_id = $1
            ORDER BY platform_account_id`,
          [postId],
        ),
      );
      expect(dropped.rows).toEqual([
        { platform_account_id: alphaYoutubeAccountId, status: "published" },
        { platform_account_id: alphaSecondAccountId, status: "cancelled" },
      ]);

      // Adding the Channel back queues that same row again instead of leaving
      // an accepted schedule with nothing left to publish.
      const readded = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [alphaAssetId],
            platformAccountId: alphaYoutubeAccountId,
          },
          {
            attachmentIds: [alphaSecondAssetId],
            platformAccountId: alphaSecondAccountId,
          },
        ],
        null,
        "integration-post-readd-again",
      );
      expect(outcomes(readded.value)).toEqual([
        {
          id: ids.get(alphaYoutubeAccountId),
          platform_account_id: alphaYoutubeAccountId,
          scheduled_at: null,
          status: "published",
        },
        {
          id: secondId,
          platform_account_id: alphaSecondAccountId,
          scheduled_at: null,
          status: "queued",
        },
      ]);

      // The revived row carries a fresh command, and the Post still holds
      // exactly one row per Channel.
      const durable = await systemTransaction(env, (client) =>
        client.query<{ commands: string; rows: string }>(
          `SELECT
             (SELECT COUNT(*)::text FROM distributions WHERE post_id = $1) AS rows,
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id = $2
                 AND topic = 'distribution.publish.requested'
                 AND state IN ('pending', 'failed')) AS commands`,
          [postId, secondId],
        ),
      );
      expect(durable.rows[0]).toEqual({ commands: "1", rows: "2" });

      // Deferring the revived Channel moves the same row to the new instant and
      // re-keys its single command to that instant.
      const deferred = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            attachmentIds: [alphaAssetId],
            platformAccountId: alphaYoutubeAccountId,
          },
          {
            attachmentIds: [alphaSecondAssetId],
            platformAccountId: alphaSecondAccountId,
          },
        ],
        deferredAt,
        "integration-post-readd-deferred",
      );
      expect(outcomes(deferred.value)).toEqual([
        {
          id: ids.get(alphaYoutubeAccountId),
          platform_account_id: alphaYoutubeAccountId,
          scheduled_at: null,
          status: "published",
        },
        {
          id: secondId,
          platform_account_id: alphaSecondAccountId,
          scheduled_at: deferredAt.toISOString(),
          status: "scheduled",
        },
      ]);
      const rekeyed = await systemTransaction(env, (client) =>
        client.query<{ dedupe_key: string }>(
          `SELECT dedupe_key
             FROM outbox_events
            WHERE aggregate_id = $1
              AND topic = 'distribution.publish.requested'
              AND state IN ('pending', 'failed')`,
          [secondId],
        ),
      );
      expect(rekeyed.rows.map(({ dedupe_key }) => dedupe_key)).toEqual([
        `distribution:${secondId}:distribution.publish.requested:at:${deferredAt.getTime()}`,
      ]);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-readd-draft",
          "integration-post-readd-first",
          "integration-post-readd-drop",
          "integration-post-readd-again",
          "integration-post-readd-deferred",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // A draft is complete without any Channel: an explicit empty selection
  // persists, saving a target and then clearing it again is authoritative for
  // every later session, and only scheduling still requires a Channel.
  it("saves and clears a Channel-less draft while scheduling requires one", async () => {
    const posts = postServiceWith("youtube");
    const created = await createAlphaPost(
      posts,
      { defaultText: "Channel-less draft", targets: [] },
      "integration-post-empty-draft",
    );
    const postId = created.value.id;

    try {
      expect(created.value).toMatchObject({
        default_text: "Channel-less draft",
        // A freshly created Post has not been edited, so its revision is still
        // the `posts.revision` default; only an accepted save advances it.
        revision: 0,
        status: "draft",
        targets: [],
      });

      // An empty target set is a composition choice, not an empty Post: a
      // composition carrying neither text nor media is still refused.
      await expect(
        createAlphaPost(posts, { defaultText: "   ", targets: [] }, "integration-post-empty-blank"),
      ).rejects.toMatchObject({
        code: "validation_error",
        status: 422,
      });

      const withTarget = await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          {
            brandProfileId: alphaBrandProfileId,
            targets: [{ hashtags: ["draft"], platformAccountId: alphaYoutubeAccountId }],
          },
          "integration-post-empty-add-target",
        ),
      );
      expect(withTarget.value.targets).toHaveLength(1);

      const cleared = await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          { brandProfileId: alphaBrandProfileId, targets: [] },
          "integration-post-empty-clear",
        ),
      );
      expect(cleared.value.targets).toEqual([]);

      // A later session reads the cleared composition from the database rather
      // than from anything the saving request held.
      const reloaded = await Effect.runPromise(posts.getPost(env, { ...alpha }, postId));
      expect(reloaded.targets).toEqual([]);
      const saved = await systemTransaction(env, (client) =>
        client.query<{ targets: string }>(
          "SELECT COUNT(*)::text AS targets FROM post_targets WHERE post_id = $1",
          [postId],
        ),
      );
      expect(saved.rows[0]?.targets).toBe("0");

      // Scheduling remains the operation that requires a Channel, whether the
      // request names none or the saved set is empty.
      await expect(
        scheduleAlphaPost(posts, postId, [], null, "integration-post-empty-schedule"),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: "Scheduling requires at least one channel target.",
        status: 422,
      });
      await expect(
        Effect.runPromise(
          posts.schedulePost(
            env,
            alpha,
            postId,
            { brandProfileId: alphaBrandProfileId, scheduledAt: null },
            "integration-post-empty-schedule-saved",
          ),
        ),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: "Scheduling requires at least one channel target.",
        status: 422,
      });
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-empty-draft",
          "integration-post-empty-blank",
          "integration-post-empty-add-target",
          "integration-post-empty-clear",
          "integration-post-empty-schedule",
          "integration-post-empty-schedule-saved",
        ],
      );
    }
  });

  // A local deletion never un-publishes a live Platform copy and never
  // releases media another retained Post still holds.
  it("deletes a Post by cancelling only its pending work", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Retire me" },
      "integration-post-delete-draft",
    );
    const postId = draft.value.id;

    try {
      const scheduled = await scheduleAlphaPost(
        posts,
        postId,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        null,
        "integration-post-delete-schedule",
      );
      // `distributions` is unordered, so each row is keyed by its Channel: the
      // first scheduled Channel is the one published, the second is cancelled.
      const publishedId = distributionIdForChannel(scheduled.value, alphaYoutubeAccountId);
      const queuedId = distributionIdForChannel(scheduled.value, alphaSecondAccountId);
      // A Distribution only reaches 'published' after its command has been
      // delivered, so the command is marked published alongside the status. That
      // is what lets the outcome read below distinguish "no pending work left"
      // from "the delete cancelled this row's command".
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE distributions
             SET status = 'published', published_at = now(),
                 platform_post_id = 'integration-published-2', updated_at = now()
             WHERE id = $1`,
            [publishedId],
          );
          yield* client.query(
            `UPDATE outbox_events
             SET state = 'published', published_at = now(), updated_at = now()
             WHERE aggregate_id = $1 AND topic = 'distribution.publish.requested'`,
            [publishedId],
          );
        }),
      );

      const deleted = await Effect.runPromise(
        posts.deletePost(
          env,
          alpha,
          postId,
          { brandProfileId: alphaBrandProfileId },
          "integration-post-delete",
        ),
      );
      expect(deleted.replayed).toBe(false);
      expect(deleted.value.id).toBe(postId);

      // Rows are read in the order the two Channels were scheduled, not UUID
      // order, so the assertion names which Channel ended where.
      const outcomes = await systemTransaction(env, (client) =>
        client.query<{ pending_commands: string; status: string }>(
          `SELECT distribution.status,
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id = distribution.id
                 AND topic = 'distribution.publish.requested'
                 AND state IN ('pending', 'failed')) AS pending_commands
           FROM distributions AS distribution
           WHERE distribution.id = ANY($1::uuid[])
           ORDER BY array_position($1::uuid[], distribution.id)`,
          [[publishedId, queuedId]],
        ),
      );
      expect(outcomes.rows).toEqual([
        { pending_commands: "0", status: "published" },
        { pending_commands: "0", status: "cancelled" },
      ]);

      // The identity is retired: no read surface still serves it.
      await expect(Effect.runPromise(posts.getPost(env, alpha, postId))).rejects.toMatchObject({
        code: "post_not_found",
        status: 404,
      });
      const listed = await Effect.runPromise(
        posts.listPosts(env, alpha, { limit: 100, offset: 0 }),
      );
      expect(listed.posts.map((post) => post.id)).not.toContain(postId);
      const attachments = await systemTransaction(env, (client) =>
        client.query<{ attachments: string; targets: string }>(
          `SELECT
             (SELECT COUNT(*)::text FROM post_attachments WHERE post_id = $1) AS attachments,
             (SELECT COUNT(*)::text FROM post_targets WHERE post_id = $1) AS targets`,
          [postId],
        ),
      );
      expect(attachments.rows[0]).toEqual({ attachments: "0", targets: "0" });
      // The seeded Asset is still retained by the seeded published Post, so the
      // deletion must not have started its reclamation clock.
      const assetState = await systemTransaction(env, (client) =>
        client.query<{
          orphan_delete_after: Date | null;
          orphaned_at: Date | null;
        }>(`SELECT orphan_delete_after, orphaned_at FROM assets WHERE id = $1`, [alphaAssetId]),
      );
      expect(assetState.rows[0]).toEqual({
        orphan_delete_after: null,
        orphaned_at: null,
      });
      await expect(
        Effect.runPromise(
          posts.deletePost(
            env,
            alpha,
            postId,
            { brandProfileId: alphaBrandProfileId },
            "integration-post-delete",
          ),
        ),
      ).resolves.toMatchObject({ replayed: true });
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-delete-draft",
          "integration-post-delete-schedule",
          "integration-post-delete",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Cancelling one Channel outcome removes only its own unleased command, so a
  // leased command stays with the consumer that already owns the attempt.
  it("accepts an idempotent schedule and removes its unpublished work on cancel", async () => {
    const distributionService = distributionServiceWith();
    const posts = postServiceWith("youtube");
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Cancel me" },
      "integration-post-cancel-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }],
      null,
      "integration-post-cancel-schedule",
    );
    const distributionId = scheduled.value.distributions[0]!.id;

    try {
      expect(scheduled.value.distributions[0]).toMatchObject({
        platform: "youtube",
        post_id: draft.value.id,
        status: "queued",
      });
      const outbox = await systemTransaction(env, (client) =>
        client.query<{ state: string }>(
          "SELECT state FROM outbox_events WHERE aggregate_id = $1 AND topic = 'distribution.publish.requested'",
          [distributionId],
        ),
      );
      expect(outbox.rows).toHaveLength(1);

      const cancelled = await Effect.runPromise(
        distributionService.cancelDistribution(
          env,
          alpha,
          distributionId,
          "integration-post-cancel",
        ),
      );
      expect(cancelled.status).toBe(204);
      const remaining = await systemTransaction(env, (client) =>
        client.query<{ count: string; status: string }>(
          `SELECT
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id = $1 AND topic = 'distribution.publish.requested'
                 AND state IN ('pending', 'failed')) AS count,
             (SELECT status FROM distributions WHERE id = $1) AS status`,
          [distributionId],
        ),
      );
      expect(remaining.rows[0]).toEqual({ count: "0", status: "cancelled" });
      await expect(
        Effect.runPromise(
          distributionService.cancelDistribution(
            env,
            alpha,
            distributionId,
            "integration-post-cancel",
          ),
        ),
      ).resolves.toMatchObject({ replayed: true });
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        [
          "integration-post-cancel-draft",
          "integration-post-cancel-schedule",
          "integration-post-cancel",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  it("cancel keeps leased publish work for the automation consumer", async () => {
    const distributionService = distributionServiceWith();
    const posts = postServiceWith("youtube");
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Leased publish work" },
      "integration-post-leased-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }],
      null,
      "integration-post-leased-schedule",
    );
    const distributionId = scheduled.value.distributions[0]!.id;

    try {
      // A leased row belongs to a running consumer; cancellation must leave it
      // alone so the consumer observes the terminal cancelled state.
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE outbox_events
           SET state = 'leased', lease_expires_at = now() + INTERVAL '5 minutes'
           WHERE aggregate_id = $1
             AND topic = 'distribution.publish.requested'
             AND state IN ('pending', 'failed')`,
          [distributionId],
        ),
      );
      await expect(
        Effect.runPromise(
          distributionService.cancelDistribution(
            env,
            alpha,
            distributionId,
            "integration-post-leased-cancel",
          ),
        ),
      ).resolves.toMatchObject({ status: 204 });
      const remaining = await systemTransaction(env, (client) =>
        client.query<{ state: string }>(
          `SELECT state FROM outbox_events
           WHERE aggregate_id = $1
             AND topic = 'distribution.publish.requested'`,
          [distributionId],
        ),
      );
      expect(remaining.rows.map((row) => row.state)).toEqual(["leased"]);
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        [
          "integration-post-leased-draft",
          "integration-post-leased-schedule",
          "integration-post-leased-cancel",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // A creator still drives one Channel outcome directly: pending work stays
  // editable, in-flight work is only asked to stop, and anything that already
  // published or failed permanently is refused instead of silently rewritten.
  it("keeps per-Channel outcomes editable only while they are pending", async () => {
    const distributionService = distributionServiceWith(["youtube", "instagram", "facebook"]);
    const posts = postServiceWith(["youtube", "instagram", "facebook"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Per Channel outcomes" },
      "integration-post-outcomes-draft",
    );
    const postId = draft.value.id;

    try {
      const scheduled = await scheduleAlphaPost(
        posts,
        postId,
        [
          { platformAccountId: alphaYoutubeAccountId },
          { platformAccountId: alphaSecondAccountId },
          { platformAccountId: alphaThirdAccountId },
        ],
        new Date(Date.now() + 7_200_000),
        "integration-post-outcomes-schedule",
      );
      const [queued, inflight, published] = scheduled.value.distributions.map(({ id }) => id) as [
        string,
        string,
        string,
      ];

      await expect(
        Effect.runPromise(
          distributionService.updateDistribution(
            env,
            alpha,
            queued,
            { scheduledAt: new Date(Date.now() + 10_800_000) },
            "integration-post-outcomes-reschedule",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });

      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE distributions SET status = 'awaiting_provider', updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [[inflight, published]],
        ),
      );
      const cancelling = await Effect.runPromise(
        distributionService.cancelDistribution(
          env,
          alpha,
          inflight,
          "integration-post-outcomes-cancel-inflight",
        ),
      );
      expect(cancelling).toMatchObject({
        status: 202,
        value: { status: "cancel_requested" },
      });

      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE distributions
           SET status = 'published', published_at = now(), updated_at = now()
           WHERE id = $1`,
          [published],
        ),
      );
      await expect(
        Effect.runPromise(
          distributionService.updateDistribution(
            env,
            alpha,
            published,
            { scheduledAt: new Date(Date.now() + 10_800_000) },
            "integration-post-outcomes-update-published",
          ),
        ),
      ).rejects.toMatchObject({
        code: "distribution_not_scheduled",
        status: 409,
      });
      await expect(
        Effect.runPromise(
          distributionService.cancelDistribution(
            env,
            alpha,
            published,
            "integration-post-outcomes-cancel-published",
          ),
        ),
      ).rejects.toMatchObject({ code: "invalid_state", status: 409 });

      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE distributions
           SET status = 'failed', failure_code = 'provider_rejected',
               failure_retryable = FALSE, error_message = 'Permanently rejected.',
               updated_at = now()
           WHERE id = $1`,
          [inflight],
        ),
      );
      await expect(
        Effect.runPromise(
          distributionService.retryDistribution(
            env,
            alpha,
            inflight,
            "integration-post-outcomes-retry-ineligible",
          ),
        ),
      ).rejects.toMatchObject({
        code: "distribution_not_retryable",
        status: 409,
      });
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-outcomes-draft",
          "integration-post-outcomes-schedule",
          "integration-post-outcomes-reschedule",
          "integration-post-outcomes-cancel-inflight",
          "integration-post-outcomes-update-published",
          "integration-post-outcomes-cancel-published",
          "integration-post-outcomes-retry-ineligible",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  it.each([
    ["saved", "audience"],
    ["request", "audience"],
    ["saved", "visibility"],
    ["request", "visibility"],
  ] as const)(
    "rejects YouTube scheduling from %s targets without %s but permits the draft",
    async (source, missingChoice) => {
      const posts = postServiceWith("youtube");
      const usageBefore = await currentUsageCount();
      const prefix = `integration-post-absent-youtube-${source}-${missingChoice}`;
      const target: PostTargetInput = {
        platformAccountId: alphaYoutubeAccountId,
        ...(missingChoice === "visibility"
          ? { providerOptions: { youtube: { madeForKids: false } } }
          : {}),
      };
      const draft = await createAlphaPost(
        posts,
        { attachmentIds: [alphaAssetId], targets: [target] },
        `${prefix}-draft`,
      );
      try {
        const reopened = await Effect.runPromise(posts.getPost(env, alpha, draft.value.id));
        expect(reopened.targets[0]?.provider_options).toEqual(
          missingChoice === "visibility" ? { youtube: { made_for_kids: false } } : null,
        );
        await expect(
          Effect.runPromise(
            posts.schedulePost(
              env,
              alpha,
              draft.value.id,
              {
                brandProfileId: alphaBrandProfileId,
                scheduledAt: null,
                ...(source === "request" ? { targets: [target] } : {}),
              },
              `${prefix}-schedule`,
            ),
          ),
        ).rejects.toMatchObject({ code: "validation_error", status: 422 });
        const unchanged = await Effect.runPromise(posts.getPost(env, alpha, draft.value.id));
        expect(unchanged.distributions).toEqual([]);
        expect(unchanged.targets).toEqual(reopened.targets);
      } finally {
        await purgeIntegrationPosts([draft.value.id], [`${prefix}-draft`, `${prefix}-schedule`]);
        await restoreUsageCount(usageBefore);
      }
    },
  );

  it.each(["youtube", "tiktok"] as const)(
    "retains incomplete %s draft choices without accepting them for delivery",
    async (platform) => {
      const posts = postServiceWith(platform);
      const accountId = platform === "youtube" ? alphaYoutubeAccountId : alphaTiktokAccountId;
      const prefix = `integration-post-incomplete-${platform}`;
      const target: PostTargetInput = {
        platformAccountId: accountId,
        providerOptions:
          platform === "youtube"
            ? { youtube: { privacyStatus: "private" } }
            : {
                tiktok: {
                  allowComment: false,
                  allowDuet: false,
                  allowStitch: false,
                  brandContent: false,
                  brandOrganic: false,
                  discloseCommercialContent: true,
                  isAiGenerated: false,
                  musicUsageConfirmed: true,
                  privacyLevel: "PUBLIC_TO_EVERYONE",
                },
              },
      };
      const draft = await createAlphaPost(
        posts,
        { attachmentIds: [alphaAssetId], targets: [target] },
        `${prefix}-draft`,
      );
      try {
        const reopened = await Effect.runPromise(posts.getPost(env, alpha, draft.value.id));
        expect(reopened.targets[0]?.provider_options).toEqual(
          platform === "youtube"
            ? { youtube: { privacy_status: "private" } }
            : {
                tiktok: {
                  allow_comment: false,
                  allow_duet: false,
                  allow_stitch: false,
                  brand_content: false,
                  brand_organic: false,
                  disclose_commercial_content: true,
                  is_ai_generated: false,
                  music_usage_confirmed: true,
                  privacy_level: "PUBLIC_TO_EVERYONE",
                },
              },
        );
        await expect(
          Effect.runPromise(
            posts.schedulePost(
              env,
              alpha,
              draft.value.id,
              { brandProfileId: alphaBrandProfileId, scheduledAt: null },
              `${prefix}-schedule`,
            ),
          ),
        ).rejects.toMatchObject({ code: "validation_error", status: 422 });
        const unchanged = await Effect.runPromise(posts.getPost(env, alpha, draft.value.id));
        expect(unchanged.distributions).toEqual([]);
        expect(unchanged.targets).toEqual(reopened.targets);
      } finally {
        await purgeIntegrationPosts([draft.value.id], [`${prefix}-draft`, `${prefix}-schedule`]);
      }
    },
  );

  // TikTok requires explicit creator choices on every publish, so a Channel
  // that omits them or states a contradictory combination is refused before any
  // work is created, and typed accepted choices survive into the durable row.
  // The Channel is the one seeded by seedPostCompositionFixtures: this scenario
  // asserts provider-option validation, which only runs after the Channel
  // lookup succeeds, so it must resolve a real connected TikTok Channel.
  it("requires and persists explicit TikTok publishing choices", async () => {
    const posts = postServiceWith("tiktok");
    const usageBefore = await currentUsageCount();
    const tiktokAccountId = alphaTiktokAccountId;
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "TikTok launch" },
      "integration-post-tiktok-draft",
    );
    const postId = draft.value.id;

    try {
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [{ platformAccountId: tiktokAccountId }],
          null,
          "integration-post-tiktok-missing-options",
        ),
      ).rejects.toMatchObject({ code: "validation_error", status: 422 });
      await expect(
        scheduleAlphaPost(
          posts,
          postId,
          [
            {
              platformAccountId: tiktokAccountId,
              providerOptions: {
                tiktok: {
                  allowComment: false,
                  allowDuet: false,
                  allowStitch: false,
                  brandContent: true,
                  brandOrganic: false,
                  isAiGenerated: false,
                  musicUsageConfirmed: true,
                  privacyLevel: "SELF_ONLY",
                },
              },
            } as never,
          ],
          null,
          "integration-post-tiktok-invalid-options",
        ),
      ).rejects.toMatchObject({ code: "validation_error", status: 422 });

      const providerOptions = {
        tiktok: {
          allowComment: true,
          allowDuet: false,
          allowStitch: false,
          brandContent: false,
          brandOrganic: true,
          isAiGenerated: false,
          musicUsageConfirmed: true as const,
          privacyLevel: "PUBLIC_TO_EVERYONE" as const,
        },
      };
      const scheduled = await scheduleAlphaPost(
        posts,
        postId,
        [
          {
            platformAccountId: tiktokAccountId,
            providerOptions,
          },
        ],
        null,
        "integration-post-tiktok-schedule",
      );
      const stored = await systemTransaction(env, (client) =>
        client.query<{ provider_options: unknown }>(
          "SELECT provider_options FROM distributions WHERE id = $1",
          [scheduled.value.distributions[0]!.id],
        ),
      );
      expect(stored.rows[0]?.provider_options).toEqual(providerOptions);
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-tiktok-draft",
          "integration-post-tiktok-missing-options",
          "integration-post-tiktok-invalid-options",
          "integration-post-tiktok-schedule",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Every accepted retry intent is its own durable command: the retry reuses
  // the same Distribution and adds a distinct command rather than reviving the
  // one that already ran.
  it("emits one distinct outbox command for every accepted distribution retry intent", async () => {
    const distributionService = distributionServiceWith();
    const posts = postServiceWith("youtube");
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Retry me" },
      "integration-post-retry-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }],
      null,
      "integration-post-retry-schedule",
    );
    const distributionId = scheduled.value.distributions[0]!.id;
    const failPendingWork = () =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE outbox_events
             SET state = 'published', published_at = now(), updated_at = now()
             WHERE aggregate_id = $1`,
            [distributionId],
          );
          yield* client.query(
            `UPDATE distributions
             SET status = 'failed', failure_code = 'provider_rate_limited',
                 failure_retryable = true, error_message = 'Retry safely.',
                 updated_at = now()
             WHERE id = $1`,
            [distributionId],
          );
        }),
      );

    try {
      await failPendingWork();
      const firstRetry = await Effect.runPromise(
        distributionService.retryDistribution(
          env,
          alpha,
          distributionId,
          "integration-post-retry-first",
        ),
      );
      expect(firstRetry).toMatchObject({
        replayed: false,
        value: { status: "queued" },
      });
      await expect(
        Effect.runPromise(
          distributionService.retryDistribution(
            env,
            alpha,
            distributionId,
            "integration-post-retry-first",
          ),
        ),
      ).resolves.toMatchObject({ replayed: true });

      await failPendingWork();
      await expect(
        Effect.runPromise(
          distributionService.retryDistribution(
            env,
            alpha,
            distributionId,
            "integration-post-retry-second",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });

      const outbox = await systemTransaction(env, (client) =>
        client.query<{ dedupe_key: string }>(
          `SELECT dedupe_key
           FROM outbox_events
           WHERE aggregate_id = $1
             AND topic = 'distribution.publish.requested'
           ORDER BY created_at, id`,
          [distributionId],
        ),
      );
      expect(outbox.rows).toHaveLength(3);
      expect(new Set(outbox.rows.map((row) => row.dedupe_key)).size).toBe(3);
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        [
          "integration-post-retry-draft",
          "integration-post-retry-schedule",
          "integration-post-retry-first",
          "integration-post-retry-second",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // A deferred publication is represented by one pending command keyed to the
  // chosen instant, and its payload stays identifiers-only so the durable row
  // remains the single source of the schedule.
  it("creates a deferred publication with one pending publish command", async () => {
    const posts = postServiceWith("youtube");
    const usageBefore = await currentUsageCount();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Later today" },
      "integration-post-deferred-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }],
      scheduledAt,
      "integration-post-deferred-schedule",
    );
    const distributionId = scheduled.value.distributions[0]!.id;

    try {
      expect(scheduled.value.status).toBe("active");
      expect(scheduled.value.distributions[0]).toMatchObject({
        scheduled_at: scheduledAt.toISOString(),
        status: "scheduled",
      });
      const outbox = await systemTransaction(env, (client) =>
        client.query<{
          dedupe_key: string;
          payload: Record<string, unknown>;
          state: string;
        }>(
          `SELECT dedupe_key, payload, state
           FROM outbox_events
           WHERE aggregate_id = $1
             AND topic = 'distribution.publish.requested'`,
          [distributionId],
        ),
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        dedupe_key: `distribution:${distributionId}:distribution.publish.requested:at:${scheduledAt.getTime()}`,
        state: "pending",
      });
      // The queue body stays identifiers/correlation only; the schedule lives
      // in the durable distribution row.
      expect(outbox.rows[0]!.payload).toEqual({
        distribution_id: distributionId,
        version: 1,
      });
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        ["integration-post-deferred-draft", "integration-post-deferred-schedule"],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Rescheduling one outcome mints a command for the new instant, never beyond
  // the delivery horizon, and cancelling drops every unpublished command so a
  // stale delayed message cannot resurrect the publication.
  it("re-keys deferred commands on reschedule and stops emitting beyond the delivery horizon", async () => {
    const distributionService = distributionServiceWith();
    const posts = postServiceWith("youtube");
    const usageBefore = await currentUsageCount();
    const start = Date.now();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Reschedule me" },
      "integration-post-reschedule-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }],
      new Date(start + 7_200_000),
      "integration-post-reschedule-schedule",
    );
    const distributionId = scheduled.value.distributions[0]!.id;
    const commandKey = (instant: Date) =>
      `distribution:${distributionId}:distribution.publish.requested:at:${instant.getTime()}`;
    const pendingKeys = async () =>
      (
        await systemTransaction(env, (client) =>
          client.query<{ dedupe_key: string }>(
            `SELECT dedupe_key
             FROM outbox_events
             WHERE aggregate_id = $1
               AND topic = 'distribution.publish.requested'
               AND state IN ('pending', 'failed')
             ORDER BY created_at, id`,
            [distributionId],
          ),
        )
      ).rows.map((row) => row.dedupe_key);

    try {
      // Rescheduling keeps earlier commands but adds one scoped to the new
      // instant; the consumer re-checks durable state so stale messages no-op.
      await expect(
        Effect.runPromise(
          distributionService.updateDistribution(
            env,
            alpha,
            distributionId,
            { scheduledAt: new Date(start + 10_800_000) },
            "integration-post-reschedule-later",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });
      expect(await pendingKeys()).toEqual([
        commandKey(new Date(start + 7_200_000)),
        commandKey(new Date(start + 10_800_000)),
      ]);

      // A schedule exactly at the horizon still fits the maximum delay.
      await expect(
        Effect.runPromise(
          distributionService.updateDistribution(
            env,
            alpha,
            distributionId,
            { scheduledAt: new Date(start + 86_400_000) },
            "integration-post-reschedule-exact-horizon",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });
      expect(await pendingKeys()).toContain(commandKey(new Date(start + 86_400_000)));

      // Beyond the horizon no new command is enqueued while the durable
      // schedule still moves.
      await expect(
        Effect.runPromise(
          distributionService.updateDistribution(
            env,
            alpha,
            distributionId,
            { scheduledAt: new Date(start + 86_400_000 + 3_600_000) },
            "integration-post-reschedule-beyond-horizon",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });
      expect(await pendingKeys()).not.toContain(
        commandKey(new Date(start + 86_400_000 + 3_600_000)),
      );
      await expect(
        Effect.runPromise(distributionService.getDistribution(env, alpha, distributionId)),
      ).resolves.toMatchObject({
        status: "scheduled",
        scheduled_at: new Date(start + 86_400_000 + 3_600_000).toISOString(),
      });

      await expect(
        Effect.runPromise(
          distributionService.cancelDistribution(
            env,
            alpha,
            distributionId,
            "integration-post-reschedule-cancel",
          ),
        ),
      ).resolves.toMatchObject({ status: 204 });
      expect(await pendingKeys()).toEqual([]);
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        [
          "integration-post-reschedule-draft",
          "integration-post-reschedule-schedule",
          "integration-post-reschedule-later",
          "integration-post-reschedule-exact-horizon",
          "integration-post-reschedule-beyond-horizon",
          "integration-post-reschedule-cancel",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Each target of one deferred schedule carries its own command at the shared
  // instant, and a schedule past the horizon is durable without commands.
  it("emits per-target deferred commands inside the horizon and none beyond it", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const inHorizonAt = new Date(Date.now() + 7_200_000);
    const inHorizonDraft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Inside the horizon" },
      "integration-post-horizon-in-draft",
    );
    const beyondAt = new Date(Date.now() + 90 * 86_400_000);
    const beyondDraft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Beyond the horizon" },
      "integration-post-horizon-beyond-draft",
    );

    try {
      const inHorizon = await scheduleAlphaPost(
        posts,
        inHorizonDraft.value.id,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        inHorizonAt,
        "integration-post-horizon-in",
      );
      const inHorizonIds = inHorizon.value.distributions.map(({ id }) => id);
      expect(inHorizon.value.distributions.map(({ status }) => status)).toEqual([
        "scheduled",
        "scheduled",
      ]);
      const commandKey = (id: string) =>
        `distribution:${id}:distribution.publish.requested:at:${inHorizonAt.getTime()}`;
      const inHorizonRows = await systemTransaction(env, (client) =>
        client.query<{ aggregate_id: string; dedupe_key: string }>(
          `SELECT aggregate_id, dedupe_key
           FROM outbox_events
           WHERE aggregate_id = ANY($1::uuid[])
             AND topic = 'distribution.publish.requested'
           ORDER BY dedupe_key`,
          [inHorizonIds],
        ),
      );
      // One unique deferred command per target at the shared instant.
      expect(inHorizonRows.rows.map((row) => row.aggregate_id).sort()).toEqual(
        [...inHorizonIds].sort(),
      );
      expect(new Set(inHorizonRows.rows.map((row) => row.dedupe_key))).toEqual(
        new Set(inHorizonIds.map(commandKey)),
      );

      const beyond = await scheduleAlphaPost(
        posts,
        beyondDraft.value.id,
        [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
        beyondAt,
        "integration-post-horizon-beyond",
      );
      const beyondIds = beyond.value.distributions.map(({ id }) => id);
      expect(beyond.value.distributions.map(({ status }) => status)).toEqual([
        "scheduled",
        "scheduled",
      ]);
      const beyondCommands = await systemTransaction(env, (client) =>
        client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM outbox_events
           WHERE aggregate_id = ANY($1::uuid[])
             AND topic = 'distribution.publish.requested'
             AND state IN ('pending', 'failed')`,
          [beyondIds],
        ),
      );
      // Beyond the horizon the durable schedules persist without commands.
      expect(beyondCommands.rows[0]?.count).toBe("0");
    } finally {
      await purgeIntegrationPosts(
        [inHorizonDraft.value.id, beyondDraft.value.id],
        [
          "integration-post-horizon-in-draft",
          "integration-post-horizon-beyond-draft",
          "integration-post-horizon-in",
          "integration-post-horizon-beyond",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // The monthly allowance is the last contended slot, so exactly one of two
  // simultaneous schedules is admitted and the loser reserves nothing.
  it("admits only one schedule at the final concurrent quota slot", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const period = currentUsagePeriod;
    const initial = await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          distributions: string;
        }>(
          `SELECT COALESCE(usage.distributions, 0)::text AS distributions
           FROM organizations AS organization
           LEFT JOIN usage_records AS usage
             ON usage.org_id = organization.id AND usage.period = $1
           WHERE organization.id = '20000000-0000-4000-8000-000000000001'`,
          [period],
        );
        // The period is bound as an untyped placeholder inside the INSERT's
        // SELECT list, where no column comparison supplies its type, so the
        // cast is what lets PostgreSQL infer `usage_records.period`'s TEXT.
        yield* client.query(
          `INSERT INTO usage_records (org_id, period, distributions)
           SELECT id, $1::text, 29 FROM organizations
            WHERE id = '20000000-0000-4000-8000-000000000001'
           ON CONFLICT (org_id, period) DO UPDATE
           SET distributions = 29, updated_at = now()`,
          [period],
        );
        return result.rows[0]!;
      }),
    );
    const first = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Quota slot one" },
      "integration-post-quota-draft-a",
    );
    const second = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Quota slot two" },
      "integration-post-quota-draft-b",
    );

    try {
      const results = await Promise.allSettled([
        scheduleAlphaPost(
          posts,
          first.value.id,
          [{ platformAccountId: alphaYoutubeAccountId }],
          null,
          "integration-post-quota-a",
        ),
        scheduleAlphaPost(
          posts,
          second.value.id,
          [{ platformAccountId: alphaSecondAccountId }],
          null,
          "integration-post-quota-b",
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({
        code: "quota_exceeded",
        status: 403,
      });
      const state = await systemTransaction(env, (client) =>
        client.query<{ distributions: string; outbox_count: string }>(
          `SELECT usage.distributions::text,
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id IN (
                 SELECT id FROM distributions
                  WHERE post_id IN ($2::uuid, $3::uuid))
                 AND topic = 'distribution.publish.requested') AS outbox_count
           FROM usage_records AS usage
           WHERE usage.org_id = '20000000-0000-4000-8000-000000000001'
             AND usage.period = $1`,
          [period, first.value.id, second.value.id],
        ),
      );
      expect(state.rows[0]).toEqual({ distributions: "30", outbox_count: "1" });
    } finally {
      await purgeIntegrationPosts(
        [first.value.id, second.value.id],
        [
          "integration-post-quota-draft-a",
          "integration-post-quota-draft-b",
          "integration-post-quota-a",
          "integration-post-quota-b",
        ],
      );
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          // The counter was pinned at the last free slot to force contention;
          // leaving it saturated would charge phantom usage against every later
          // schedule on this workspace's seeded 30-distribution allowance.
          yield* client.query(
            `UPDATE usage_records
           SET distributions = $2, updated_at = now()
           WHERE org_id = '20000000-0000-4000-8000-000000000001' AND period = $1`,
            [period, initial.distributions],
          );
        }),
      );
    }
  });

  // A plan change racing an in-flight schedule is serialized behind it, so the
  // admitted command sees one consistent entitlement decision.

  // Creator text is stored verbatim and parameterized, so SQL-shaped and
  // markup-shaped content is inert text that survives reloads, stays invisible
  // to another workspace, and disappears with the Post that owns it.
  it("stores injection-shaped Post text inertly before isolation and deletion", async () => {
    const posts = postServiceWith("youtube");
    const injectionTitle = "Integration post text '); DROP TABLE posts; --";
    const injectionText = "<script>alert('stored text')</script>'; SELECT pg_sleep(10); --";
    const draft = await createAlphaPost(
      posts,
      { defaultText: injectionText, title: injectionTitle },
      "integration-post-injection",
    );
    const postId = draft.value.id;

    try {
      expect(draft.value).toMatchObject({
        default_text: injectionText,
        title: injectionTitle,
      });
      await expect(
        createAlphaPost(
          posts,
          { defaultText: injectionText, title: injectionTitle },
          "integration-post-injection",
        ),
      ).resolves.toEqual({ ...draft, replayed: true });
      await expect(Effect.runPromise(posts.getPost(env, beta, postId))).rejects.toMatchObject({
        code: "post_not_found",
        status: 404,
      });
      await expect(Effect.runPromise(posts.getPost(env, alpha, postId))).resolves.toMatchObject({
        default_text: injectionText,
        title: injectionTitle,
      });

      await expect(
        Effect.runPromise(
          posts.deletePost(
            env,
            alpha,
            postId,
            { brandProfileId: alphaBrandProfileId },
            "integration-post-injection-delete",
          ),
        ),
      ).resolves.toMatchObject({ replayed: false });
      await expect(Effect.runPromise(posts.getPost(env, alpha, postId))).rejects.toMatchObject({
        code: "post_not_found",
        status: 404,
      });
      const rows = await systemTransaction(env, (client) =>
        client.query<{ deleted: boolean }>(
          "SELECT deleted_at IS NOT NULL AS deleted FROM posts WHERE id = $1",
          [postId],
        ),
      );
      // The row survives as a soft delete so its identity is never reused.
      expect(rows.rows[0]).toEqual({ deleted: true });
    } finally {
      await purgeIntegrationPosts(
        [postId],
        ["integration-post-injection", "integration-post-injection-delete"],
      );
    }
  });
  // A publication a consumer already claimed keeps its own lifecycle: deleting
  // the Post retires the identity and cancels what is still pending, but work
  // in flight stays with the consumer that owns the attempt.
  it("keeps claimed publication work alive when its Post is deleted", async () => {
    const posts = postServiceWith(["youtube", "instagram"]);
    const usageBefore = await currentUsageCount();
    const draft = await createAlphaPost(
      posts,
      { attachmentIds: [alphaAssetId], defaultText: "Claimed publish work" },
      "integration-post-claim-draft",
    );
    const scheduled = await scheduleAlphaPost(
      posts,
      draft.value.id,
      [{ platformAccountId: alphaYoutubeAccountId }, { platformAccountId: alphaSecondAccountId }],
      null,
      "integration-post-claim-schedule",
    );
    // Keyed by Channel, not by position: the canonical Channel's row is the one
    // leased to a consumer and therefore protected from the cancellation.
    const claimedId = distributionIdForChannel(scheduled.value, alphaYoutubeAccountId);
    const pendingId = distributionIdForChannel(scheduled.value, alphaSecondAccountId);

    try {
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE outbox_events
             SET state = 'leased', lease_expires_at = now() + INTERVAL '5 minutes'
             WHERE aggregate_id = $1 AND topic = 'distribution.publish.requested'`,
            [claimedId],
          );
          yield* client.query(
            `UPDATE distributions SET status = 'processing', updated_at = now()
             WHERE id = $1`,
            [claimedId],
          );
        }),
      );
      await Effect.runPromise(
        posts.deletePost(
          env,
          alpha,
          draft.value.id,
          { brandProfileId: alphaBrandProfileId },
          "integration-post-claim-delete",
        ),
      );
      const outcomes = await systemTransaction(env, (client) =>
        client.query<{ commands: string; status: string }>(
          `SELECT distribution.status,
             (SELECT COUNT(*)::text FROM outbox_events
               WHERE aggregate_id = distribution.id
                 AND topic = 'distribution.publish.requested'
                 AND state IN ('pending', 'failed')) AS commands
           FROM distributions AS distribution
           WHERE distribution.id = ANY($1::uuid[])
           ORDER BY array_position($1::uuid[], distribution.id)`,
          [[claimedId, pendingId]],
        ),
      );
      expect(outcomes.rows).toEqual([
        { commands: "0", status: "processing" },
        { commands: "0", status: "cancelled" },
      ]);
    } finally {
      await purgeIntegrationPosts(
        [draft.value.id],
        [
          "integration-post-claim-draft",
          "integration-post-claim-schedule",
          "integration-post-claim-delete",
        ],
      );
      await restoreUsageCount(usageBefore);
    }
  });

  // Retention is decided by references, not by edits: an unchanged selection is
  // a no-op, and only media that truly loses its last retained reference
  // starts the reclamation window.
  it("arms the reclamation clock only for media that loses its last reference", async () => {
    const posts = postServiceWith("youtube");
    const draft = await createAlphaPost(
      posts,
      {
        attachmentIds: [alphaAssetId, alphaSecondAssetId],
        defaultText: "Retention boundary",
      },
      "integration-post-detach-draft",
    );
    const postId = draft.value.id;
    const orphanState = async () =>
      (
        await systemTransaction(env, (client) =>
          client.query<{ orphaned_at: Date | null }>(
            "SELECT orphaned_at FROM assets WHERE id = $1",
            [alphaSecondAssetId],
          ),
        )
      ).rows[0]!.orphaned_at;

    try {
      expect(await orphanState()).toBeNull();
      await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          {
            attachmentIds: [alphaAssetId, alphaSecondAssetId],
            brandProfileId: alphaBrandProfileId,
            defaultText: "Retention boundary, edited",
          },
          "integration-post-detach-unchanged",
        ),
      );
      expect(await orphanState()).toBeNull();
      await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          {
            attachmentIds: [alphaAssetId],
            brandProfileId: alphaBrandProfileId,
          },
          "integration-post-detach-last",
        ),
      );
      expect(await orphanState()).toBeInstanceOf(Date);
      await Effect.runPromise(
        posts.updatePost(
          env,
          alpha,
          postId,
          {
            attachmentIds: [alphaAssetId, alphaSecondAssetId],
            brandProfileId: alphaBrandProfileId,
          },
          "integration-post-detach-readd",
        ),
      );
      expect(await orphanState()).toBeNull();
    } finally {
      await purgeIntegrationPosts(
        [postId],
        [
          "integration-post-detach-draft",
          "integration-post-detach-unchanged",
          "integration-post-detach-last",
          "integration-post-detach-readd",
        ],
      );
    }
  });

  // Media inventory reads stay single-Asset and Brand Profile scoped: the read
  // returns current processing state, media URLs are minted only for verified
  // media, and a Profile that is gone or retired refuses every read.
  it("scopes single-Asset reads and signs media only for verified bytes", async () => {
    const harness = assetServiceHarness([]);
    const asset = harness.service;
    await expect(
      Effect.runPromise(asset.getAsset(env, alpha, alphaSecondAssetId)),
    ).resolves.toMatchObject({
      asset_type: "image",
      brand_profile_id: alphaBrandProfileId,
      id: alphaSecondAssetId,
      // Text composition lives on Post rows, so an Asset never carries a body
      // and never embeds a signed capability.
      status: "ready",
    });

    // Signing reads the verified publishable shape this spec owns: a ready
    // object on the Asset's protected key plus its ready 'original' rendition.
    const preview = await Effect.runPromise(
      asset.getAssetPreviewUrl(env, alpha, alphaSecondAssetId),
    );
    expect(preview.url).toContain("preview");
    expect(harness.signedGets[0]).not.toHaveProperty("downloadFilename");
    const download = await Effect.runPromise(
      asset.getAssetDownloadUrl(env, alpha, alphaSecondAssetId),
    );
    expect(download.url).toContain("download");
    expect(harness.signedGets[1]).toMatchObject({
      downloadFilename: "second.png",
    });

    // Media still preparing has nothing verified to sign yet.
    await expect(
      Effect.runPromise(asset.getAssetPreviewUrl(env, alpha, alphaProcessingAssetId)),
    ).rejects.toMatchObject({ code: "invalid_state", status: 409 });

    await systemTransaction(env, (client) =>
      client.query(
        `UPDATE brand_profiles SET deleted_at = now(), purge_at = now() + INTERVAL '7 days'
         WHERE id = '${alphaBrandProfileId}'`,
      ),
    );
    // A read against a retired Profile is refused the same way a read of a row
    // that does not exist is: `getAssetRowEffect` filters soft-deleted Profiles
    // out with `activeBrandProfilePredicate` instead of loading the row and
    // reporting `brand_profile_deleted`, which is the 409 only a *mutation*
    // raises (via `requireActiveBrandProfileEffect`). So a caller sees 404 for
    // both a missing Asset and one whose Profile was retired.
    try {
      await expect(
        Effect.runPromise(asset.getAsset(env, alpha, alphaSecondAssetId)),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await expect(
        Effect.runPromise(asset.getAssetDownloadUrl(env, alpha, alphaSecondAssetId)),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE brand_profiles SET deleted_at = NULL, purge_at = NULL
           WHERE id = '${alphaBrandProfileId}'`,
        ),
      );
    }
  });
  it("keeps upload quota writes below the accepted local p95 latency budget", async () => {
    const sampleCount = 20;
    const ids = Array.from(
      { length: sampleCount * 2 },
      (_, index) => `91000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
    );
    const harness = assetServiceHarness(ids);
    const durations: number[] = [];

    for (let index = 0; index < sampleCount; index += 1) {
      const idempotencyKey = `integration-quota-budget-${index}`;
      const startedAt = performance.now();
      const created = await Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "image",
            brand_profile_id: alphaBrandProfileId,
            content_type: "image/png",
            file_size: 1_024,
            filename: `quota-budget-${index}.png`,
            title: `Integration asset quota budget ${index}`,
          },
          idempotencyKey,
        ),
      );
      durations.push(performance.now() - startedAt);
      await Effect.runPromise(
        harness.service.abortUploadSession(
          env,
          alpha,
          created.value.upload_session.id,
          `${idempotencyKey}-abort`,
        ),
      );
    }

    const ordered = [...durations].sort((left, right) => left - right);
    const p95 = ordered[Math.ceil(sampleCount * 0.95) - 1] ?? 0;
    expect(durations).toHaveLength(sampleCount);
    expect(p95).toBeLessThan(500);
  });

  it("serializes concurrent upload-count and storage-byte reservations", async () => {
    const period = assetTestPeriod;
    const initial = await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          storage_bytes: string;
          uploads: string;
        }>(
          `SELECT COALESCE(usage.uploads, 0)::text AS uploads,
                COALESCE(usage.storage_bytes, 0)::text AS storage_bytes
         FROM organizations AS organization
         LEFT JOIN usage_records AS usage
           ON usage.org_id = organization.id AND usage.period = $2
         WHERE organization.id = $1`,
          [alpha.organizationId, period],
        );
        return result.rows[0]!;
      }),
    );

    const quotaState = () =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<{
            reservation_bytes: string;
            reservation_count: string;
            resident_bytes: string;
          }>(
            `SELECT COUNT(*)::text AS reservation_count,
                  COALESCE(SUM(reservation.bytes), 0)::text AS reservation_bytes,
                  (
                    SELECT COALESCE(
                             SUM(
                               GREATEST(
                                 COALESCE(object.bytes, 0),
                                 COALESCE(object.reserved_bytes, 0)
                               )
                             ),
                             0
                           )::text
                      FROM asset_objects AS object
                     WHERE object.org_id = $1
                       AND object.status <> 'deleted'
                  ) AS resident_bytes
             FROM asset_quota_reservations AS reservation
             WHERE reservation.org_id = $1
               AND reservation.state = 'reserved'`,
            [alpha.organizationId],
          );
          return result.rows[0]!;
        }),
      );
    const setUsage = (uploads: number, storageBytes: number) =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO usage_records (org_id, period, uploads, storage_bytes)
           SELECT id, $2, $3, $4
           FROM organizations WHERE id = $1
           ON CONFLICT (org_id, period) DO UPDATE
           SET uploads = EXCLUDED.uploads,
               storage_bytes = EXCLUDED.storage_bytes,
               updated_at = now()`,
            [alpha.organizationId, period, uploads, storageBytes],
          );
        }),
      );
    const cleanupRace = (keyPrefix: string, title: string) =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `DELETE FROM outbox_events
           WHERE aggregate_id IN (SELECT id FROM assets WHERE title = $1)`,
            [title],
          );
          yield* client.query("DELETE FROM assets WHERE title = $1", [title]);
          yield* client.query("DELETE FROM idempotency_keys WHERE idempotency_key LIKE $1", [
            `${keyPrefix}%`,
          ]);
        }),
      );
    const runRace = async (ids: string[], keyPrefix: string, title: string) => {
      const harness = assetServiceHarness(ids);
      const input = {
        asset_type: "image" as const,
        brand_profile_id: alphaBrandProfileId,
        content_type: "image/png",
        file_size: 1024,
        filename: `${keyPrefix}.png`,
        tags: ["integration", "quota"],
        title,
      };
      const results = await Promise.allSettled([
        Effect.runPromise(harness.service.createUploadSession(env, alpha, input, `${keyPrefix}-a`)),
        Effect.runPromise(harness.service.createUploadSession(env, alpha, input, `${keyPrefix}-b`)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({
        code: "quota_exceeded",
        status: 422,
      });
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const state = yield* client.query<{
            assets: string;
            reservations: string;
          }>(
            `SELECT
             (SELECT COUNT(*)::text FROM assets WHERE title = $1) AS assets,
             (SELECT COUNT(*)::text
              FROM asset_quota_reservations AS reservation
              JOIN asset_upload_sessions AS session
                ON session.id = reservation.session_id
              JOIN assets AS asset ON asset.id = session.asset_id
              WHERE asset.title = $1 AND reservation.state = 'reserved') AS reservations`,
            [title],
          );
          expect(state.rows[0]).toEqual({ assets: "1", reservations: "1" });
        }),
      );
    };

    const uploadTitle = "Integration asset concurrent quota uploads";
    const storageTitle = "Integration asset concurrent quota storage";
    try {
      // The upload gate charges `usage_records.uploads` plus every reservation
      // the workspace still holds, so the baseline is one admission below the
      // free allowance: the winner fills the last slot and the loser is refused.
      const beforeUploads = await quotaState();
      const uploadBaseline =
        (COMMUNITY_LIMITS.max_uploads ?? 0) - Number(beforeUploads.reservation_count) - 1;
      expect(uploadBaseline).toBeGreaterThanOrEqual(0);
      await setUsage(uploadBaseline, 0);
      await runRace(
        [
          "91000000-0000-4000-8000-000000000101",
          "91000000-0000-4000-8000-000000000102",
          "91000000-0000-4000-8000-000000000103",
          "91000000-0000-4000-8000-000000000104",
        ],
        "integration-upload-quota",
        uploadTitle,
      );
      await cleanupRace("integration-upload-quota", uploadTitle);

      // Storage is charged from the live inventory, never from
      // `usage_records.storage_bytes` (asset-service.ts:657): the gate sums
      // GREATEST(object.bytes, object.reserved_bytes) over every non-deleted
      // object plus live reservations. So the padding must be a real inventoried
      // object on a real ready Asset — writing the counter leaves the gate with
      // a full 1 GiB of headroom and admits both racers. The padding leaves room
      // for exactly this race's own 1 KiB upload, so the winner fills the last
      // slot and the loser is refused.
      const beforeStorage = await quotaState();
      const storageAllowance = COMMUNITY_LIMITS.max_storage_bytes ?? 0;
      const storagePadding =
        storageAllowance -
        Number(beforeStorage.resident_bytes) -
        Number(beforeStorage.reservation_bytes) -
        1024;
      expect(storagePadding).toBeGreaterThanOrEqual(0);
      await setUsage(0, 0);
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          // The Asset must exist before its object: the composite foreign key
          // (asset_id, brand_profile_id) is what makes the padding a real
          // inventoried byte count the storage gate actually reads.
          yield* client.query(
            `INSERT INTO assets
               (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
                status, original_filename, mime_type, finalized_at)
             VALUES (
               $1, '${alpha.organizationId}', '${alphaBrandProfileId}',
               '10000000-0000-4000-8000-000000000001', 'image',
               'Integration asset storage quota padding', 'ready',
               'storage-padding.png', 'image/png', now() - interval '1 day'
             )`,
            [alphaStoragePaddingAssetId],
          );
          yield* client.query(
            `INSERT INTO asset_objects
               (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
                content_type, status)
             VALUES (
               $1, $2, '${alphaBrandProfileId}', 'original', $3, $4::bigint,
               'image/png', 'ready'
             )`,
            [
              alpha.organizationId,
              alphaStoragePaddingAssetId,
              `integration/storage-padding/${alphaStoragePaddingAssetId}`,
              storagePadding,
            ],
          );
        }),
      );
      await runRace(
        [
          "91000000-0000-4000-8000-000000000105",
          "91000000-0000-4000-8000-000000000106",
          "91000000-0000-4000-8000-000000000107",
          "91000000-0000-4000-8000-000000000108",
        ],
        "integration-storage-quota",
        storageTitle,
      );
    } finally {
      await cleanupRace("integration-upload-quota", uploadTitle);
      await cleanupRace("integration-storage-quota", storageTitle);
      // The padding object is not owned by either race's assets, so it has to
      // be removed explicitly or every later quota spec sees 1 GiB already
      // held. Its Asset goes with it: `asset_objects_asset_brand_profile_fkey`
      // cascades the object on Asset deletion, so deleting the Asset alone
      // would suffice, but both rows are named so the intent is explicit.
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query("DELETE FROM asset_objects WHERE asset_id = $1", [
            alphaStoragePaddingAssetId,
          ]);
          yield* client.query("DELETE FROM assets WHERE id = $1", [alphaStoragePaddingAssetId]);
        }),
      );
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE usage_records AS usage
           SET uploads = $3, storage_bytes = $4, updated_at = now()
           FROM organizations AS organization
           WHERE usage.org_id = organization.id
             AND organization.id = $1
             AND usage.period = $2`,
            [alpha.organizationId, period, initial.uploads, initial.storage_bytes],
          );
        }),
      );
    }
  });
  it("releases abandoned upload reservations lazily on the next usage read for retry within quota", async () => {
    const period = assetTestPeriod;
    const initial = await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          storage_bytes: string;
          uploads: string;
        }>(
          `SELECT COALESCE(usage.uploads, 0)::text AS uploads,
                COALESCE(usage.storage_bytes, 0)::text AS storage_bytes
         FROM organizations AS organization
         LEFT JOIN usage_records AS usage
           ON usage.org_id = organization.id AND usage.period = $2
         WHERE organization.id = $1`,
          [alpha.organizationId, period],
        );
        return result.rows[0]!;
      }),
    );

    const titleA = "Integration asset abandon first upload";
    const titleB = "Integration asset abandon retry upload";
    const cleanup = () =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `DELETE FROM outbox_events
           WHERE aggregate_id IN (
             SELECT id FROM assets WHERE title IN ($1, $2)
           )`,
            [titleA, titleB],
          );
          yield* client.query("DELETE FROM assets WHERE title IN ($1, $2)", [titleA, titleB]);
          yield* client.query(
            "DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'integration-lazy-quota-%'",
          );
        }),
      );

    try {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO usage_records (org_id, period, uploads, storage_bytes)
           SELECT id, $2, 9, 0
           FROM organizations WHERE id = $1
           ON CONFLICT (org_id, period) DO UPDATE
           SET uploads = 9, storage_bytes = 0, updated_at = now()`,
            [alpha.organizationId, period],
          );
        }),
      );

      const harness = assetServiceHarness([
        "91000000-0000-4000-8000-000000000121",
        "91000000-0000-4000-8000-000000000122",
        "91000000-0000-4000-8000-000000000123",
        "91000000-0000-4000-8000-000000000124",
      ]);

      const first = await Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "image",
            brand_profile_id: alphaBrandProfileId,
            content_type: "image/png",
            file_size: 1024,
            filename: "abandon-a.png",
            title: titleA,
          },
          "integration-lazy-quota-first",
        ),
      );
      expect(first.replayed).toBe(false);

      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE asset_upload_sessions
           SET expires_at = $2::timestamptz, updated_at = now()
           WHERE id = $1`,
            [first.value.upload_session.id, new Date("2026-07-18T11:59:00.000Z")],
          );
        }),
      );

      const second = await Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "image",
            brand_profile_id: alphaBrandProfileId,
            content_type: "image/png",
            file_size: 1024,
            filename: "abandon-b.png",
            title: titleB,
          },
          "integration-lazy-quota-retry",
        ),
      );
      expect(second.replayed).toBe(false);

      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const rows = yield* client.query<{
            asset_status: string;
            reservation_state: string;
            session_status: string;
            title: string;
          }>(
            `SELECT
             asset.title,
             asset.status AS asset_status,
             session.status AS session_status,
             reservation.state AS reservation_state
           FROM assets asset
           JOIN asset_upload_sessions session ON session.asset_id = asset.id
           JOIN asset_quota_reservations reservation ON reservation.session_id = session.id
           WHERE asset.title IN ($1, $2)
           ORDER BY asset.title`,
            [titleA, titleB],
          );
          expect(rows.rows).toEqual([
            {
              asset_status: "failed",
              reservation_state: "released",
              session_status: "expired",
              title: titleA,
            },
            {
              asset_status: "pending_upload",
              reservation_state: "reserved",
              session_status: "created",
              title: titleB,
            },
          ]);
        }),
      );
    } finally {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE usage_records AS usage
           SET uploads = $3, storage_bytes = $4, updated_at = now()
           FROM organizations AS organization
           WHERE usage.org_id = organization.id
             AND organization.id = $1
             AND usage.period = $2`,
            [alpha.organizationId, period, initial.uploads, initial.storage_bytes],
          );
        }),
      );
    }
  });

  it("never releases active unexpired upload reservations on usage reads", async () => {
    const period = assetTestPeriod;
    const initial = await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          storage_bytes: string;
          uploads: string;
        }>(
          `SELECT COALESCE(usage.uploads, 0)::text AS uploads,
                COALESCE(usage.storage_bytes, 0)::text AS storage_bytes
         FROM organizations AS organization
         LEFT JOIN usage_records AS usage
           ON usage.org_id = organization.id AND usage.period = $2
         WHERE organization.id = $1`,
          [alpha.organizationId, period],
        );
        return result.rows[0]!;
      }),
    );

    const titleActive = "Integration asset active upload reservation";
    const titleBlocked = "Integration asset blocked upload reservation";
    const cleanup = () =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `DELETE FROM outbox_events
           WHERE aggregate_id IN (
             SELECT id FROM assets WHERE title IN ($1, $2)
           )`,
            [titleActive, titleBlocked],
          );
          yield* client.query("DELETE FROM assets WHERE title IN ($1, $2)", [
            titleActive,
            titleBlocked,
          ]);
          yield* client.query(
            "DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'integration-active-quota-%'",
          );
        }),
      );

    try {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO usage_records (org_id, period, uploads, storage_bytes)
           SELECT id, $2, 9, 0
           FROM organizations WHERE id = $1
           ON CONFLICT (org_id, period) DO UPDATE
           SET uploads = 9, storage_bytes = 0, updated_at = now()`,
            [alpha.organizationId, period],
          );
        }),
      );

      const harness = assetServiceHarness([
        "91000000-0000-4000-8000-000000000131",
        "91000000-0000-4000-8000-000000000132",
        "91000000-0000-4000-8000-000000000133",
        "91000000-0000-4000-8000-000000000134",
      ]);

      const active = await Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "image",
            brand_profile_id: alphaBrandProfileId,
            content_type: "image/png",
            file_size: 1024,
            filename: "active.png",
            title: titleActive,
          },
          "integration-active-quota-first",
        ),
      );
      expect(active.replayed).toBe(false);

      await expect(
        Effect.runPromise(
          harness.service.createUploadSession(
            env,
            alpha,
            {
              asset_type: "image",
              brand_profile_id: alphaBrandProfileId,
              content_type: "image/png",
              file_size: 1024,
              filename: "blocked.png",
              title: titleBlocked,
            },
            "integration-active-quota-second",
          ),
        ),
      ).rejects.toMatchObject({
        code: "quota_exceeded",
        status: 422,
      });

      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const row = yield* client.query<{
            asset_status: string;
            reservation_state: string;
            session_status: string;
          }>(
            `SELECT
             asset.status AS asset_status,
             session.status AS session_status,
             reservation.state AS reservation_state
           FROM assets asset
           JOIN asset_upload_sessions session ON session.asset_id = asset.id
           JOIN asset_quota_reservations reservation ON reservation.session_id = session.id
           WHERE session.id = $1`,
            [active.value.upload_session.id],
          );
          expect(row.rows[0]).toEqual({
            asset_status: "pending_upload",
            reservation_state: "reserved",
            session_status: "created",
          });
        }),
      );
    } finally {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE usage_records AS usage
           SET uploads = $3, storage_bytes = $4, updated_at = now()
           FROM organizations AS organization
           WHERE usage.org_id = organization.id
             AND organization.id = $1
             AND usage.period = $2`,
            [alpha.organizationId, period, initial.uploads, initial.storage_bytes],
          );
        }),
      );
    }
  });

  it("handles concurrent usage reads over stale reservations without double-releasing or deadlocking", async () => {
    const period = assetTestPeriod;
    const initial = await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          storage_bytes: string;
          uploads: string;
        }>(
          `SELECT COALESCE(usage.uploads, 0)::text AS uploads,
                COALESCE(usage.storage_bytes, 0)::text AS storage_bytes
         FROM organizations AS organization
         LEFT JOIN usage_records AS usage
           ON usage.org_id = organization.id AND usage.period = $2
         WHERE organization.id = $1`,
          [alpha.organizationId, period],
        );
        return result.rows[0]!;
      }),
    );

    const titlePrefix = "Integration asset concurrent lazy quota";
    const cleanup = () =>
      systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `DELETE FROM outbox_events
           WHERE aggregate_id IN (
             SELECT id FROM assets WHERE title LIKE $1
           )`,
            [`${titlePrefix}%`],
          );
          yield* client.query("DELETE FROM assets WHERE title LIKE $1", [`${titlePrefix}%`]);
          yield* client.query(
            "DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'integration-concurrent-lazy-%'",
          );
        }),
      );

    try {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `INSERT INTO usage_records (org_id, period, uploads, storage_bytes)
           SELECT id, $2, 9, 0
           FROM organizations WHERE id = $1
           ON CONFLICT (org_id, period) DO UPDATE
           SET uploads = 9, storage_bytes = 0, updated_at = now()`,
            [alpha.organizationId, period],
          );
        }),
      );

      const seedHarness = assetServiceHarness([
        "91000000-0000-4000-8000-000000000140",
        "91000000-0000-4000-8000-000000000141",
      ]);
      const seeded = await Effect.runPromise(
        seedHarness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "image",
            brand_profile_id: alphaBrandProfileId,
            content_type: "image/png",
            file_size: 1024,
            filename: "stale-seed.png",
            title: `${titlePrefix} seed`,
          },
          "integration-concurrent-lazy-seed",
        ),
      );
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE asset_upload_sessions
           SET expires_at = $2::timestamptz, updated_at = now()
           WHERE id = $1`,
            [seeded.value.upload_session.id, new Date("2026-07-18T11:59:00.000Z")],
          );
        }),
      );

      const concurrentHarness = assetServiceHarness([
        "91000000-0000-4000-8000-000000000142",
        "91000000-0000-4000-8000-000000000143",
        "91000000-0000-4000-8000-000000000144",
        "91000000-0000-4000-8000-000000000145",
        "91000000-0000-4000-8000-000000000146",
        "91000000-0000-4000-8000-000000000147",
        "91000000-0000-4000-8000-000000000148",
        "91000000-0000-4000-8000-000000000149",
      ]);
      const attempts = [0, 1, 2, 3].map((index) =>
        Effect.runPromise(
          concurrentHarness.service.createUploadSession(
            env,
            alpha,
            {
              asset_type: "image",
              brand_profile_id: alphaBrandProfileId,
              content_type: "image/png",
              file_size: 1024,
              filename: `concurrent-${index}.png`,
              title: `${titlePrefix} attempt ${index}`,
            },
            `integration-concurrent-lazy-attempt-${index}`,
          ),
        ),
      );
      const settled = await Promise.allSettled(attempts);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(3);
      for (const rej of rejected) {
        expect(rej.reason).toMatchObject({
          code: "quota_exceeded",
          status: 422,
        });
      }

      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const state = yield* client.query<{
            active_reservations: string;
            released_reservations: string;
          }>(
            `SELECT
             COUNT(*) FILTER (WHERE reservation.state = 'reserved')::text AS active_reservations,
             COUNT(*) FILTER (WHERE reservation.state = 'released')::text AS released_reservations
           FROM asset_quota_reservations reservation
           JOIN assets asset ON asset.id = (
             SELECT session.asset_id FROM asset_upload_sessions session WHERE session.id = reservation.session_id
           )
           WHERE asset.title LIKE $1`,
            [`${titlePrefix}%`],
          );
          expect(state.rows[0]).toEqual({
            active_reservations: "1",
            released_reservations: "1",
          });
        }),
      );
    } finally {
      await cleanup();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            `UPDATE usage_records AS usage
           SET uploads = $3, storage_bytes = $4, updated_at = now()
           FROM organizations AS organization
           WHERE usage.org_id = organization.id
             AND organization.id = $1
             AND usage.period = $2`,
            [alpha.organizationId, period, initial.uploads, initial.storage_bytes],
          );
        }),
      );
    }
  });

  it("reserves quota, verifies uploaded metadata, and completes once", async () => {
    const assetId = "91000000-0000-4000-8000-000000000001";
    const sessionId = "91000000-0000-4000-8000-000000000002";
    const harness = assetServiceHarness([assetId, sessionId]);
    const input = {
      asset_type: "image" as const,
      brand_profile_id: alphaBrandProfileId,
      content_type: "image/png",
      file_size: 1024,
      filename: "integration.png",
      tags: ["integration"],
      title: "Integration asset upload",
    };
    const created = await Effect.runPromise(
      harness.service.createUploadSession(
        env,
        alpha,
        input,
        "integration-asset-upload",
        "integration-asset-upload-request",
      ),
    );
    expect(created).toMatchObject({
      replayed: false,
      value: {
        asset: { id: assetId, status: "pending_upload" },
        upload_session: {
          id: sessionId,
          single_upload: {
            headers: { "Content-Type": "image/png" },
            method: "PUT",
          },
          strategy: "single",
        },
      },
    });
    expect(created.value.upload_session.single_upload?.headers).not.toHaveProperty(
      "Content-Length",
    );
    expect(harness.uploadKeys).toHaveLength(1);
    await expect(
      Effect.runPromise(
        harness.service.createUploadSession(env, alpha, input, "integration-asset-upload"),
      ),
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      Effect.runPromise(harness.service.getUploadSession(env, beta, sessionId)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      Effect.runPromise(harness.service.getUploadSession(env, alpha, sessionId)),
    ).resolves.toMatchObject({
      upload_session: {
        id: sessionId,
        single_upload: {
          headers: { "Content-Type": "image/png" },
          method: "PUT",
        },
        strategy: "single",
      },
      uploaded_parts: [],
    });

    const key = harness.uploadKeys[0]!;
    harness.objects.set(key, {
      contentType: "image/png",
      etag: "integration-etag",
      key,
      size: 1024,
      uploadedAt: new Date("2026-07-18T12:01:00.000Z"),
    });
    const completed = await Effect.runPromise(
      harness.service.completeUploadSession(
        env,
        alpha,
        sessionId,
        {},
        "integration-asset-complete",
        "integration-asset-complete-request",
      ),
    );
    expect(completed).toMatchObject({
      replayed: false,
      value: {
        file_size: 1024,
        mime_type: "image/png",
        status: "processing",
      },
    });
    await expect(
      Effect.runPromise(
        harness.service.completeUploadSession(
          env,
          alpha,
          sessionId,
          {},
          "integration-asset-complete",
        ),
      ),
    ).resolves.toEqual({ ...completed, replayed: true });

    // Completion settles the upload: the Asset is `processing` and its verified
    // bytes live on the staging object. Signing media for a browser requires the
    // publishable shape instead — a ready Asset, a ready object on the canonical
    // protected key, and the ready `original` rendition that references it — so
    // the two statements below stand in for the promotion and approval the
    // automation processor commits for this upload.
    const promotedKey = readyObjectKey(alpha.organizationId, assetId, "original");
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          "UPDATE assets SET status = 'ready', updated_at = now() WHERE id = $1",
          [assetId],
        );
        const promoted = yield* client.query<{ id: string }>(
          `UPDATE asset_objects
           SET kind = 'original',
               profile = NULL,
               r2_key = $2,
               status = 'ready',
               updated_at = now()
           WHERE asset_id = $1
             AND kind = 'staging'
             AND status = 'ready'
           RETURNING id`,
          [assetId, promotedKey],
        );
        const objectId = promoted.rows[0]?.id;
        if (!objectId) {
          throw new Error("Promotion found no verified staging object.");
        }
        yield* client.query(
          `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, object_id, status)
           SELECT object.org_id, object.asset_id, object.brand_profile_id,
                  'original', object.id, 'ready'
           FROM asset_objects AS object
           WHERE object.id = $1::uuid`,
          [objectId],
        );
      }),
    );
    const preview = await Effect.runPromise(
      harness.service.getAssetPreviewUrl(env, alpha, assetId),
    );
    const download = await Effect.runPromise(
      harness.service.getAssetDownloadUrl(env, alpha, assetId),
    );
    expect(preview).toEqual({
      expires_at: "2026-07-18T12:15:00.000Z",
      url: expect.stringMatching(/^https:\/\/r2\.example\/preview\//),
    });
    expect(download).toEqual({
      expires_at: "2026-07-18T12:15:00.000Z",
      url: expect.stringMatching(/^https:\/\/r2\.example\/download\//),
    });
    // Signing reads the promoted object, so the capability never names the
    // upload-writable staging key.
    expect(harness.signedGets).toEqual([
      {
        expiresInSeconds: 900,
        key: promotedKey,
      },
      {
        downloadFilename: "integration.png",
        expiresInSeconds: 900,
        key: promotedKey,
      },
    ]);
    await expect(
      Effect.runPromise(harness.service.getAssetPreviewUrl(env, beta, assetId)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          processing_events: string;
          processing_request_id: string;
          reservation_state: string;
          upload_events: string;
        }>(
          `SELECT
           (
             SELECT COUNT(*)::text
             FROM outbox_events
             WHERE topic = 'asset.upload.created'
               AND dedupe_key = $1::text
           ) AS upload_events,
           (
             SELECT COUNT(*)::text
             FROM outbox_events
             WHERE topic = 'asset.processing.requested'
               AND dedupe_key = $1::text
           ) AS processing_events,
           (
             SELECT payload->>'request_id'
             FROM outbox_events
             WHERE topic = 'asset.processing.requested'
               AND dedupe_key = $1::text
           ) AS processing_request_id,
           (
             SELECT state
             FROM asset_quota_reservations
             WHERE session_id = $1::uuid
           ) AS reservation_state`,
          [sessionId],
        );
        expect(result.rows[0]).toEqual({
          processing_events: "1",
          processing_request_id: "integration-asset-complete-request",
          reservation_state: "committed",
          upload_events: "0",
        });
      }),
    );
  });
  it("signs bounded multipart parts and rejects forged completion lists", async () => {
    const assetId = "91000000-0000-4000-8000-000000000007";
    const sessionId = "91000000-0000-4000-8000-000000000008";
    const fileSize = 25 * 1024 * 1024 + 1;
    const harness = assetServiceHarness([
      assetId,
      sessionId,
      "91000000-0000-4000-8000-000000000009",
      "91000000-0000-4000-8000-000000000010",
    ]);
    const created = await Effect.runPromise(
      harness.service.createUploadSession(
        env,
        alpha,
        {
          asset_type: "video",
          brand_profile_id: alphaBrandProfileId,
          content_type: "video/mp4",
          file_size: fileSize,
          filename: "Integration asset multipart.mp4",
          title: "Integration asset multipart",
        },
        "integration-asset-multipart-upload",
      ),
    );
    expect(created.value.upload_session).toMatchObject({
      id: sessionId,
      multipart: {
        max_parallel_parts: 4,
        part_count: 4,
        part_size: 8 * 1024 * 1024,
      },
      single_upload: null,
      strategy: "multipart",
    });
    await expect(
      Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "video",
            brand_profile_id: alphaBrandProfileId,
            content_type: "video/mp4",
            file_size: fileSize,
            filename: "Integration asset multipart.mp4",
            title: "Integration asset multipart",
          },
          "integration-asset-multipart-upload",
        ),
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect(harness.storageEvents).toEqual([
      `create:${harness.multipartKeys[0]}`,
      `create:${harness.multipartKeys[1]}`,
      `abort:${harness.multipartKeys[1]}`,
    ]);
    const urls = await Effect.runPromise(
      harness.service.createUploadPartUrls(
        env,
        alpha,
        sessionId,
        { part_numbers: [4, 1] },
        "integration-asset-multipart-parts",
      ),
    );
    expect(urls.parts.map((part) => part.part_number)).toEqual([1, 4]);
    expect(urls.parts[1]?.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(harness.multipartKeys).toHaveLength(2);

    await expect(
      Effect.runPromise(
        harness.service.completeUploadSession(
          env,
          alpha,
          sessionId,
          {
            parts: [
              { etag: "etag-1", part_number: 1 },
              { etag: "forged-duplicate", part_number: 1 },
            ],
          },
          "integration-asset-multipart-forged",
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_part_list", status: 422 });

    const key = harness.multipartKeys[0]!;
    harness.objects.set(key, {
      contentType: "video/mp4",
      etag: "multipart-final",
      key,
      size: fileSize,
      uploadedAt: new Date("2026-07-18T12:02:00.000Z"),
    });
    const completed = await Effect.runPromise(
      harness.service.completeUploadSession(
        env,
        alpha,
        sessionId,
        {
          parts: [1, 2, 3, 4].map((partNumber) => ({
            etag: `etag-${partNumber}`,
            part_number: partNumber,
          })),
        },
        "integration-asset-multipart-complete",
      ),
    );
    expect(completed.value).toMatchObject({
      file_size: fileSize,
      status: "processing",
    });
    const detail = await Effect.runPromise(harness.service.getUploadSession(env, alpha, sessionId));
    expect(detail.uploaded_parts).toHaveLength(4);
    expect(detail.uploaded_parts[3]?.size).toBe(1024 * 1024 + 1);
  });

  it("aborts and expires sessions while releasing reservations", async () => {
    const abortedHarness = assetServiceHarness([
      "91000000-0000-4000-8000-000000000009",
      "91000000-0000-4000-8000-000000000010",
    ]);
    const input = {
      asset_type: "image" as const,
      brand_profile_id: alphaBrandProfileId,
      content_type: "image/png",
      file_size: 1024,
      filename: "Integration asset abort.png",
      title: "Integration asset abort",
    };
    const aborted = await Effect.runPromise(
      abortedHarness.service.createUploadSession(
        env,
        alpha,
        input,
        "integration-asset-abort-upload",
      ),
    );
    await expect(
      Effect.runPromise(
        abortedHarness.service.abortUploadSession(
          env,
          alpha,
          aborted.value.upload_session.id,
          "integration-asset-abort",
        ),
      ),
    ).resolves.toEqual({ replayed: false });
    await expect(
      Effect.runPromise(
        abortedHarness.service.abortUploadSession(
          env,
          alpha,
          aborted.value.upload_session.id,
          "integration-asset-abort",
        ),
      ),
    ).resolves.toEqual({ replayed: true });
    expect(abortedHarness.deletedKeys).toEqual([abortedHarness.uploadKeys[0]]);

    const expiredHarness = assetServiceHarness([
      "91000000-0000-4000-8000-000000000011",
      "91000000-0000-4000-8000-000000000012",
    ]);
    const expiring = await Effect.runPromise(
      expiredHarness.service.createUploadSession(
        env,
        alpha,
        {
          ...input,
          filename: "Integration asset expired.png",
          title: "Integration asset expired",
        },
        "integration-asset-expired-upload",
      ),
    );
    expiredHarness.setNow("2026-07-19T12:00:01.000Z");
    const detail = await Effect.runPromise(
      expiredHarness.service.getUploadSession(env, alpha, expiring.value.upload_session.id),
    );
    expect(detail).toMatchObject({
      asset: {
        failure: { code: "upload_session_expired", retryable: true },
        status: "failed",
      },
      upload_session: { single_upload: null, status: "expired" },
    });

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{ state: string }>(
          `SELECT state
         FROM asset_quota_reservations
         WHERE session_id IN ($1, $2)
         ORDER BY session_id`,
          [aborted.value.upload_session.id, expiring.value.upload_session.id],
        );
        expect(result.rows.map((row) => row.state)).toEqual(["released", "released"]);
      }),
    );
  });

  it.each(["single", "multipart"] as const)(
    "completes logical %s abort over HTTP after remote cleanup fails",
    async (strategy) => {
      const assetId =
        strategy === "single"
          ? "91000000-0000-4000-8000-000000000151"
          : "91000000-0000-4000-8000-000000000153";
      const sessionId =
        strategy === "single"
          ? "91000000-0000-4000-8000-000000000152"
          : "91000000-0000-4000-8000-000000000154";
      const idempotencyKey = `integration-asset-cleanup-failure-${strategy}`;
      const harness = assetServiceHarness([assetId, sessionId]);
      const created = await Effect.runPromise(
        harness.service.createUploadSession(
          env,
          alpha,
          {
            asset_type: "video",
            brand_profile_id: alphaBrandProfileId,
            content_type: "video/mp4",
            file_size: strategy === "multipart" ? 25 * 1024 * 1024 + 1 : 1_024,
            filename: `Integration asset cleanup failure ${strategy}.mp4`,
            title: `Integration asset cleanup failure ${strategy}`,
          },
          `${idempotencyKey}-upload`,
        ),
      );
      expect(created.value.upload_session.strategy).toBe(strategy);
      const cleanup = vi.fn(() =>
        Effect.fail(new StorageUnavailableError({ message: "R2 remote cleanup failed" })),
      );
      if (strategy === "single") {
        harness.storage.delete.mockImplementation(cleanup);
      } else {
        harness.storage.resumeMultipartUpload.mockImplementation((_key, uploadId) =>
          Effect.succeed({
            abort: cleanup,
            complete: () => Effect.die("Abort must not complete an upload"),
            uploadId,
            uploadPart: () => Effect.die("Abort must not upload a part"),
          }),
        );
      }
      const app = createApiApp({
        assetService: harness.service,
        resolveActor: async () => alphaActor,
        verifyJwtToken: async () => alphaIdentity,
      });
      const request = () =>
        app.request(
          `/api/v1/asset-upload-sessions/${sessionId}`,
          {
            headers: {
              Authorization: bearerAuthorization,
              "Idempotency-Key": idempotencyKey,
            },
            method: "DELETE",
          },
          env,
        );

      const response = await request();
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(cleanup).toHaveBeenCalledTimes(1);
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<{
            asset_status: string;
            failure_code: string;
            session_status: string;
            reservation_state: string;
            response_status: number;
            response_body: unknown;
          }>(
            `SELECT a.status AS asset_status, a.failure_code,
                  s.status AS session_status, r.state AS reservation_state,
                  i.response_status, i.response_body
           FROM assets a
           JOIN asset_upload_sessions s ON s.asset_id = a.id
           JOIN asset_quota_reservations r ON r.session_id = s.id
           JOIN idempotency_keys i ON i.org_id = a.org_id
             AND i.operation = 'abortUploadSession' AND i.idempotency_key = $3
           WHERE a.id = $1 AND s.id = $2`,
            [assetId, sessionId, idempotencyKey],
          );
          expect(result.rows).toEqual([
            {
              asset_status: "failed",
              failure_code: "upload_aborted",
              session_status: "aborted",
              reservation_state: "released",
              response_status: 204,
              response_body: null,
            },
          ]);
        }),
      );
      const replay = await request();
      expect(replay.status).toBe(204);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("allows missing-object completion to retry after upload visibility", async () => {
    const assetId = "91000000-0000-4000-8000-000000000013";
    const sessionId = "91000000-0000-4000-8000-000000000014";
    const harness = assetServiceHarness([assetId, sessionId]);
    await Effect.runPromise(
      harness.service.createUploadSession(
        env,
        alpha,
        {
          asset_type: "image",
          brand_profile_id: alphaBrandProfileId,
          content_type: "image/png",
          file_size: 512,
          filename: "Integration asset delayed.png",
          title: "Integration asset delayed",
        },
        "integration-asset-delayed-upload",
      ),
    );
    await expect(
      Effect.runPromise(
        harness.service.completeUploadSession(
          env,
          alpha,
          sessionId,
          {},
          "integration-asset-delayed-complete",
        ),
      ),
    ).rejects.toMatchObject({ code: "missing_object", status: 422 });

    const key = harness.uploadKeys[0]!;
    harness.objects.set(key, {
      contentType: "image/png",
      etag: "eventually-visible",
      key,
      size: 512,
      uploadedAt: new Date("2026-07-18T12:02:00.000Z"),
    });
    await expect(
      Effect.runPromise(
        harness.service.completeUploadSession(
          env,
          alpha,
          sessionId,
          {},
          "integration-asset-delayed-complete",
        ),
      ),
    ).resolves.toMatchObject({
      replayed: false,
      value: { status: "processing" },
    });
  });

  it("durably fails and replays authoritative metadata mismatches", async () => {
    const assetId = "91000000-0000-4000-8000-000000000003";
    const sessionId = "91000000-0000-4000-8000-000000000004";
    const harness = assetServiceHarness([assetId, sessionId]);
    const created = await Effect.runPromise(
      harness.service.createUploadSession(
        env,
        alpha,
        {
          asset_type: "image",
          brand_profile_id: alphaBrandProfileId,
          content_type: "image/png",
          file_size: 2048,
          filename: "integration-mismatch.png",
          title: "Integration asset mismatch",
        },
        "integration-asset-mismatch-upload",
      ),
    );
    const key = harness.uploadKeys[0]!;
    harness.objects.set(key, {
      contentType: "image/png",
      etag: "wrong-size",
      key,
      size: 1024,
      uploadedAt: new Date("2026-07-18T12:01:00.000Z"),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        Effect.runPromise(
          harness.service.completeUploadSession(
            env,
            alpha,
            created.value.upload_session.id,
            {},
            "integration-asset-mismatch-complete",
          ),
        ),
      ).rejects.toMatchObject({
        code: "metadata_mismatch",
        status: 422,
      });
    }
    await expect(
      Effect.runPromise(harness.service.getAsset(env, alpha, assetId)),
    ).resolves.toMatchObject({
      failure: {
        code: "metadata_mismatch",
        retryable: false,
      },
      status: "failed",
    });
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{ state: string }>(
          `SELECT state
         FROM asset_quota_reservations
         WHERE session_id = $1`,
          [sessionId],
        );
        expect(result.rows[0]?.state).toBe("released");
      }),
    );
  });

  it("rejects replies before mutation when the provider capability is unavailable", async () => {
    await expect(
      Effect.runPromise(
        service.replyToComment(
          env,
          alpha,
          "80000000-0000-4000-8000-000000000001",
          alphaBrandProfileId,
          "Thanks!",
          "integration-reply-unsupported",
        ),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 422,
    });
  });

  it("accepts one durable reply, replays it, and creates one outbox event", async () => {
    const capabilities = service.platformCapabilities().map((capability) =>
      capability.platform === "youtube"
        ? {
            ...capability,
            comments: true,
            notes: ["Enabled only for the integration acceptance test."],
            reply: true,
          }
        : capability,
    );
    const replyService = createCoreApiService(capabilities);
    const first = await Effect.runPromise(
      replyService.replyToComment(
        env,
        alpha,
        "80000000-0000-4000-8000-000000000001",
        alphaBrandProfileId,
        "Thanks for watching!",
        "integration-reply-accepted",
        "integration-reply-request",
      ),
    );
    expect(first).toMatchObject({
      replayed: false,
      value: {
        reply_status: "queued",
        reply_text: "Thanks for watching!",
      },
    });

    const replay = await Effect.runPromise(
      replyService.replyToComment(
        env,
        alpha,
        "80000000-0000-4000-8000-000000000001",
        alphaBrandProfileId,
        "Thanks for watching!",
        "integration-reply-accepted",
      ),
    );
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(
      Effect.runPromise(
        replyService.replyToComment(
          env,
          alpha,
          "80000000-0000-4000-8000-000000000001",
          alphaBrandProfileId,
          "A different reply",
          "integration-reply-accepted",
        ),
      ),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      status: 409,
    });
    await expect(
      Effect.runPromise(
        replyService.replyToComment(
          env,
          beta,
          "80000000-0000-4000-8000-000000000001",
          betaBrandProfileId,
          "Cross-tenant reply",
          "integration-cross-tenant-reply",
        ),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          count: string;
          request_id: string;
        }>(
          `SELECT COUNT(*)::text AS count,
                MIN(payload->>'request_id') AS request_id
         FROM outbox_events
         WHERE dedupe_key = 'integration-reply-accepted'
           AND topic = 'comment.reply.requested'`,
        );
        expect(result.rows[0]).toEqual({
          count: "1",
          request_id: "integration-reply-request",
        });
      }),
    );
  });

  it("disconnects idempotently and cancels only future work", async () => {
    const accountId = "50000000-0000-4000-8000-000000000009";
    const distributionId = "60000000-0000-4000-8000-000000000009";
    const inFlightDistributionId = "60000000-0000-4000-8000-000000000010";
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            access_token, scopes)
         VALUES (
           $1,
           '20000000-0000-4000-8000-000000000001',
           '${alphaBrandProfileId}',
           'threads',
           'integration-disconnect',
           'local-only',
           ARRAY[]::text[]
         )`,
          [accountId],
        );
        // Scheduled and already-processing work belong to two different Posts,
        // because one Post/account pair owns exactly one Distribution row and
        // the same Channel cannot appear twice on a Post.
        yield* insertFixturePost(client, {
          accountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.disconnectScheduled,
          title: "Integration disconnect scheduled",
        });
        yield* insertFixturePost(client, {
          accountId,
          assetId: alphaAssetId,
          postId: fixturePostIds.disconnectInFlight,
          title: "Integration disconnect in flight",
        });
        yield* client.query(
          `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attachment_ids, scheduled_at)
         VALUES (
           $1,
           '20000000-0000-4000-8000-000000000001',
           '${alphaBrandProfileId}',
           $3,
           $2,
           'threads',
           'scheduled',
           ARRAY[$4::uuid],
           '2026-08-01T00:00:00Z'
         )`,
          [distributionId, accountId, fixturePostIds.disconnectScheduled, alphaAssetId],
        );
        // In-flight work is not future work; disconnecting must leave it alone.
        yield* client.query(
          `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attachment_ids)
         VALUES (
           $1,
           '20000000-0000-4000-8000-000000000001',
           '${alphaBrandProfileId}',
           $3,
           $2,
           'threads',
           'processing',
           ARRAY[$4::uuid]
         )`,
          [inFlightDistributionId, accountId, fixturePostIds.disconnectInFlight, alphaAssetId],
        );
      }),
    );

    await expect(
      Effect.runPromise(
        service.disconnectPlatform(env, beta, accountId, "integration-cross-tenant-disconnect"),
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });

    await expect(
      Effect.runPromise(
        service.disconnectPlatform(env, alpha, accountId, "integration-disconnect"),
      ),
    ).resolves.toEqual({ replayed: false, value: undefined });
    await expect(
      Effect.runPromise(
        service.disconnectPlatform(env, alpha, accountId, "integration-disconnect"),
      ),
    ).resolves.toEqual({ replayed: true, value: undefined });

    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        const result = yield* client.query<{
          account_exists: boolean;
          future_status: string;
          in_flight_status: string;
        }>(
          `SELECT
           EXISTS (
             SELECT 1 FROM platform_accounts WHERE id = $1
           ) AS account_exists,
           (SELECT status FROM distributions WHERE id = $2) AS future_status,
           (SELECT status FROM distributions WHERE id = $3)
             AS in_flight_status`,
          [accountId, distributionId, inFlightDistributionId],
        );
        expect(result.rows[0]).toEqual({
          account_exists: false,
          future_status: "cancelled",
          in_flight_status: "processing",
        });
      }),
    );
  });

  it("serializes platform quota acceptance while allowing an existing reconnect", async () => {
    const allowance = COMMUNITY_LIMITS.max_platforms;
    if (allowance === null) throw new Error("This boundary scenario requires a bounded quota.");
    const baselineIds = Array.from(
      { length: allowance - 1 },
      (_, index) => `integration-quota-baseline-${index}`,
    );
    // One Channel per Provider per Brand Profile: the concurrent candidates use
    // distinct Providers so the quota, not provider uniqueness, decides them.
    const candidates = [
      { id: "integration-quota-a", platform: "youtube" as const },
      { id: "integration-quota-b", platform: "tiktok" as const },
    ];
    const accountIds = candidates.map(({ id }) => id);
    const connection = (id: string, platform: "threads" | "youtube" | "tiktok") =>
      saveOAuthConnection(
        env,
        platform,
        {
          brandProfileId: betaBrandProfileId,
          organizationId: beta.organizationId,
          userId: beta.userId,
        },
        {
          accessToken: `access-${id}`,
          account: { id },
          scopes: ["threads_basic"],
        },
      );
    try {
      for (const id of baselineIds) await connection(id, "threads");
      const results = await Promise.allSettled(
        candidates.map(({ id, platform }) => connection(id, platform)),
      );
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({ code: "quota_exceeded", status: 403 });
      const accepted = candidates[results.findIndex((result) => result.status === "fulfilled")]!;
      await expect(connection(accepted.id, accepted.platform)).resolves.toBeUndefined();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM platform_accounts WHERE org_id = $1",
            [beta.organizationId],
          );
          expect(result.rows[0]?.count).toBe(String(allowance));
        }),
      );

      const boundedPolicy = { ...COMMUNITY_LIMITS };
      try {
        const community = await vi.importActual<typeof Domain>("@meltiply/domain");
        Object.assign(COMMUNITY_LIMITS, community.COMMUNITY_LIMITS);
        await Promise.all(candidates.map(({ id, platform }) => connection(id, platform)));
        await systemTransaction(env, (client) =>
          Effect.gen(function* () {
            const result = yield* client.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM platform_accounts WHERE org_id = $1",
              [beta.organizationId],
            );
            expect(result.rows[0]?.count).toBe(String(allowance + 1));
          }),
        );
      } finally {
        Object.assign(COMMUNITY_LIMITS, boundedPolicy);
      }
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          "DELETE FROM platform_accounts WHERE org_id = $1 AND platform_user_id = ANY($2::text[])",
          [beta.organizationId, [...baselineIds, ...accountIds]],
        ),
      );
    }
  });

  it("upserts OAuth connections with encrypted tokens and restores account health", async () => {
    try {
      await saveOAuthConnection(
        env,
        "threads",
        {
          brandProfileId: betaBrandProfileId,
          organizationId: beta.organizationId,
          userId: beta.userId,
        },
        {
          accessToken: "integration-access-token",
          account: {
            displayName: "Integration Creator",
            id: "integration-oauth-user",
          },
          expiresAt: "2026-09-01T00:00:00.000Z",
          refreshToken: "integration-refresh-token",
          scopes: ["threads_basic", "threads_content_publish"],
        },
      );

      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<{
            access_token: string;
            connection_status: string;
            refresh_token: string;
            revoked_at: Date | null;
            scopes: string[];
          }>(
            `SELECT
             access_token, refresh_token, scopes, connection_status, revoked_at
           FROM platform_accounts
           WHERE platform_user_id = 'integration-oauth-user'`,
          );
          expect(result.rows[0]).toMatchObject({
            connection_status: "connected",
            revoked_at: null,
            scopes: ["threads_basic", "threads_content_publish"],
          });
          expect(result.rows[0]?.access_token).toMatch(/^meltiply:v2:primary:/);
          expect(result.rows[0]?.refresh_token).toMatch(/^meltiply:v2:primary:/);
          expect(result.rows[0]?.access_token).not.toContain("integration-access-token");
        }),
      );

      await expect(
        saveOAuthConnection(
          env,
          "threads",
          {
            brandProfileId: alphaBrandProfileId,
            organizationId: "20000000-0000-4000-8000-000000000099",
            userId: alpha.userId,
          },
          {
            accessToken: "discarded-token",
            account: { id: "integration-oauth-user" },
            scopes: [],
          },
        ),
      ).rejects.toMatchObject({
        code: "invalid_state",
        status: 409,
      });
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          "DELETE FROM platform_accounts WHERE platform_user_id = 'integration-oauth-user'",
        ),
      );
    }
  });

  it("allows one Channel per Provider per Brand Profile", async () => {
    const acceptedId = "integration-provider-unique-accepted";
    const rejectedId = "integration-provider-unique-rejected";
    const connection = (id: string) =>
      saveOAuthConnection(
        env,
        "threads",
        {
          brandProfileId: betaBrandProfileId,
          organizationId: beta.organizationId,
          userId: beta.userId,
        },
        {
          accessToken: `access-${id}`,
          account: { id },
          scopes: ["threads_basic"],
        },
      );
    try {
      // The seeded Beta profile owns no Threads Channel yet, so the first
      // external identity fills the single Provider slot.
      await expect(connection(acceptedId)).resolves.toBeUndefined();
      await expect(connection(rejectedId)).rejects.toMatchObject({
        code: "invalid_state",
        status: 409,
      });
      // Reconnecting the accepted external identity refreshes its own Channel
      // rather than competing for the slot.
      await expect(connection(acceptedId)).resolves.toBeUndefined();
      await systemTransaction(env, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<{ count: string; platform_user_id: string }>(
            `SELECT COUNT(*)::text AS count, MIN(platform_user_id) AS platform_user_id
               FROM platform_accounts
              WHERE brand_profile_id = $1 AND platform = 'threads'`,
            [betaBrandProfileId],
          );
          expect(result.rows[0]).toEqual({ count: "1", platform_user_id: acceptedId });
        }),
      );
    } finally {
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM platform_accounts WHERE platform_user_id IN ($1, $2)", [
          acceptedId,
          rejectedId,
        ]),
      );
    }
  });

  it("reveals a revocation token only through the owning tenant", async () => {
    const revoke = vi.fn(async () => undefined);
    const registry = new ProviderRegistry();
    registry.register("youtube", {
      capability: {
        ...service.platformCapabilities().find((capability) => capability.platform === "youtube")!,
        analytics: false,
      },
      revoke,
      transferModes: [],
    });
    const accountId = "50000000-0000-4000-8000-000000000001";

    await revokeOAuthConnection(env, beta, accountId, registry);
    expect(revoke).not.toHaveBeenCalled();

    await revokeOAuthConnection(env, alpha, accountId, registry);
    expect(revoke).toHaveBeenCalledWith("local-only-not-a-provider-credential", expect.any(Object));
  });

  it("reveals publication credentials only after an owning-tenant read", async () => {
    const accountId = "50000000-0000-4000-8000-000000000008";
    // A dedicated Brand Profile keeps the TikTok fixture free of the seeded
    // YouTube Channel and the composition fixtures' Provider slots.
    const credentialProfileId = "a0000000-0000-4000-8000-0000000000c1";
    const readRequirements = vi.fn(
      async (_context: ProviderRequestContext, providerCredentials: ProviderCredentials) => {
        expect(providerCredentials).toEqual({
          accessToken: "integration-tiktok-access",
          accountId: "integration-tiktok-creator",
        });
        return {
          commentAllowed: true,
          creatorDisplayName: "Integration TikTok Creator",
          creatorUsername: "integration.creator",
          duetAllowed: false,
          maxVideoDurationSeconds: 180,
          platform: "tiktok" as const,
          privacyLevels: ["PUBLIC_TO_EVERYONE" as const, "SELF_ONLY" as const],
          stitchAllowed: true,
        };
      },
    );
    const registry = new ProviderRegistry();
    registry.register("tiktok", {
      capability: {
        ...service.platformCapabilities().find((capability) => capability.platform === "tiktok")!,
        analytics: false,
      },
      getPublicationRequirements: readRequirements,
      transferModes: [],
    });
    const encrypted = await tokenCipherFor(env).encrypt("integration-tiktok-access");
    await systemTransaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `INSERT INTO brand_profiles (id, org_id, name, color)
           VALUES ($1, '20000000-0000-4000-8000-000000000001',
                   'Integration Credential Brand', '#1d4ed8')`,
          [credentialProfileId],
        );
        yield* client.query(
          `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            access_token, scopes, connection_status, token_expires_at)
         VALUES ($1, '20000000-0000-4000-8000-000000000001',
                 $2, 'tiktok',
                 'integration-tiktok-creator', $3,
                 ARRAY['user.info.basic', 'video.publish'], 'connected',
                 '2026-08-01T00:00:00Z')`,
          [accountId, credentialProfileId, encrypted],
        );
      }),
    );

    try {
      await expect(
        getPublicationRequirements(
          env,
          beta,
          accountId,
          "integration-requirements-beta",
          registry,
          new Date("2026-07-19T00:00:00Z"),
        ),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(readRequirements).not.toHaveBeenCalled();

      await expect(
        getPublicationRequirements(
          env,
          alpha,
          accountId,
          "integration-requirements-alpha",
          registry,
          new Date("2026-07-19T00:00:00Z"),
        ),
      ).resolves.toMatchObject({
        creatorUsername: "integration.creator",
        platform: "tiktok",
      });
      expect(readRequirements).toHaveBeenCalledOnce();
      expect(readRequirements.mock.calls[0]?.[0]).toMatchObject({
        operationId: "getPlatformPublishingRequirements",
        requestId: "integration-requirements-alpha",
      });

      readRequirements.mockRejectedValueOnce(new Error("boom"));
      await expect(
        getPublicationRequirements(
          env,
          alpha,
          accountId,
          "integration-requirements-unexpected",
          registry,
          new Date("2026-07-19T00:00:00Z"),
        ),
      ).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });

      readRequirements.mockRejectedValueOnce(
        new ProviderAdapterError(
          classifyProviderFailure({
            code: "media_format_unsupported",
            status: 422,
          }),
        ),
      );
      await expect(
        getPublicationRequirements(
          env,
          alpha,
          accountId,
          "integration-requirements-deterministic",
          registry,
          new Date("2026-07-19T00:00:00Z"),
        ),
      ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });

      await systemTransaction(env, (client) =>
        client.query(
          "UPDATE platform_accounts SET connection_status = 'reconnect_required' WHERE id = $1",
          [accountId],
        ),
      );
      await expect(
        getPublicationRequirements(
          env,
          alpha,
          accountId,
          "integration-requirements-reconnect",
          registry,
          new Date("2026-07-19T00:00:00Z"),
        ),
      ).rejects.toMatchObject({ code: "invalid_state", status: 409 });
      expect(readRequirements).toHaveBeenCalledTimes(3);
    } finally {
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM brand_profiles WHERE id = $1", [credentialProfileId]),
      );
    }
  });

  it("administers the shared workspace, roles, invitations, seats, and audit", async () => {
    const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
    const run = lifecycleRunToken();
    const inviteEmail = `lifecycle-seat-${run}@meltiply.local`;
    const ownerIdentity = jwtIdentity({
      email: "alpha@meltiply.local",
      id: alpha.subject,
      name: "Alpha Creator",
    });
    const adminIdentity = jwtIdentity({
      email: "beta@meltiply.local",
      id: beta.subject,
      name: "Beta Admin",
    });
    const editorIdentity = jwtIdentity({
      email: "gamma@meltiply.local",
      id: "auth_user_local_gamma",
      name: "Gamma Editor",
    });
    const { request, sent } = lifecycleInvitationHarness({
      identities: {
        admin: adminIdentity,
        editor: editorIdentity,
        owner: ownerIdentity,
      },
    });

    const installation = await request("/api/v1/installation", { method: "GET" });
    expect(installation.status).toBe(200);
    expect(await installation.json()).toMatchObject({
      seat_limit: 10,
      workspace: {
        created_at: expect.any(String),
        id: sharedWorkspaceId,
        role: "admin",
        updated_at: expect.any(String),
      },
    });

    const members = await request(`/api/v1/workspaces/${sharedWorkspaceId}/members`, {
      method: "GET",
    });
    expect(members.status).toBe(200);
    const memberBody = await members.json<{
      members: { email: string; is_installation_owner: boolean; role: string }[];
    }>();
    expect(memberBody.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "alpha@meltiply.local",
          is_installation_owner: true,
          role: "admin",
        }),
        expect.objectContaining({ email: "gamma@meltiply.local", role: "editor" }),
      ]),
    );

    // A Workspace Admin may invite an Editor but never another Admin.
    const forbiddenAdminInvite = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      {
        body: JSON.stringify({ email: `admin-invite-${run}@meltiply.local`, role: "admin" }),
        headers: { "Idempotency-Key": `admin-invite-${run}` },
        method: "POST",
      },
      "admin",
    );
    expect(forbiddenAdminInvite.status).toBe(403);
    expect(errorCodeFrom(await forbiddenAdminInvite.json())).toBe("forbidden_role_assignment");

    const invited = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
      body: JSON.stringify({ email: inviteEmail, role: "editor" }),
      headers: { "Idempotency-Key": `owner-invite-${run}` },
      method: "POST",
    });
    expect(invited.status).toBe(201);
    expect(sent).toHaveLength(1);
    const invitation = await invited.json<{ id: string; role: string; status: string }>();
    expect(invitation).toMatchObject({ role: "editor", status: "pending" });

    const pending = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
      method: "GET",
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      invitations: expect.arrayContaining([
        expect.objectContaining({ email: inviteEmail, role: "editor" }),
      ]),
    });

    const revoked = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${invitation.id}`,
      {
        headers: { "Idempotency-Key": `owner-revoke-${run}` },
        method: "DELETE",
      },
    );
    expect(revoked.status).toBe(204);

    // A role change applies to the next request and is audited.
    const roleChange = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/members/10000000-0000-4000-8000-000000000003`,
      {
        body: JSON.stringify({ role: "viewer" }),
        headers: { "Idempotency-Key": `role-change-${run}` },
        method: "PATCH",
      },
    );
    expect(roleChange.status).toBe(200);
    try {
      const editorRead = await request("/api/v1/users/me", { method: "GET" }, "editor");
      expect(editorRead.status).toBe(200);
      await expect(editorRead.json()).resolves.toMatchObject({
        active_organization: { role: "viewer" },
      });
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE org_members SET role = 'editor'
           WHERE org_id = $1 AND user_id = '10000000-0000-4000-8000-000000000003'`,
          [sharedWorkspaceId],
        ),
      );
    }

    const renamed = await request(`/api/v1/workspaces/${sharedWorkspaceId}`, {
      body: JSON.stringify({ name: `Shared Workspace ${run}` }),
      headers: { "Idempotency-Key": `rename-${run}` },
      method: "PATCH",
    });
    expect(renamed.status).toBe(200);
    await systemTransaction(env, (client) =>
      client.query("UPDATE organizations SET name = 'Alpha Creator''s workspace' WHERE id = $1", [
        sharedWorkspaceId,
      ]),
    );

    const audit = await request(`/api/v1/workspaces/${sharedWorkspaceId}/audit`, {
      method: "GET",
    });
    expect(audit.status).toBe(200);
    const auditBody = await audit.json<{ entries: { action: string }[] }>();
    expect(auditBody.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "invitation.created",
        "invitation.revoked",
        "member.role_changed",
        "workspace.renamed",
      ]),
    );

    const forbiddenAudit = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/audit`,
      { method: "GET" },
      "editor",
    );
    expect(forbiddenAudit.status).toBe(403);
  });

  it("enforces the ten-Seat limit and renews expired invitations atomically", async () => {
    const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
    const run = lifecycleRunToken();
    const ownerIdentity = jwtIdentity({
      email: "alpha@meltiply.local",
      id: alpha.subject,
      name: "Alpha Creator",
    });
    const { request } = lifecycleInvitationHarness({ identities: { owner: ownerIdentity } });
    const emailFor = (index: number) => `seat-limit-${run}-${index}@meltiply.local`;
    const created: { id: string; email: string }[] = [];
    try {
      // Start from the seeded Seat usage minus any pending invitations so the
      // ten-Seat arithmetic is independent of fixture invitations.
      await systemTransaction(env, (client) =>
        client.query(
          `DELETE FROM workspace_invitations
           WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [sharedWorkspaceId],
        ),
      );
      for (let index = 0; index < 6; index += 1) {
        const response = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
          body: JSON.stringify({ email: emailFor(index), role: "viewer" }),
          headers: { "Idempotency-Key": `seat-invite-${run}-${index}` },
          method: "POST",
        });
        expect(response.status).toBe(201);
        const body = await response.json<{ email: string; id: string }>();
        created.push({ email: body.email, id: body.id });
      }

      const overflow = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
        body: JSON.stringify({ email: emailFor(6), role: "viewer" }),
        headers: { "Idempotency-Key": `seat-overflow-${run}` },
        method: "POST",
      });
      expect(overflow.status).toBe(409);
      expect(errorCodeFrom(await overflow.json())).toBe("seat_limit_reached");

      // Expiring one invitation releases its reservation; a new invitation may
      // consume that Seat. Renewing the expired row must then fail rather than
      // pushing usage above the limit.
      await systemTransaction(env, (client) =>
        client.query(
          `UPDATE workspace_invitations SET expires_at = now() - interval '1 day'
           WHERE id = $1`,
          [created[0]!.id],
        ),
      );
      const replacement = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
        body: JSON.stringify({ email: emailFor(6), role: "viewer" }),
        headers: { "Idempotency-Key": `seat-replacement-${run}` },
        method: "POST",
      });
      expect(replacement.status).toBe(201);
      const replacementBody = await replacement.json<{ id: string }>();
      created.push({ email: emailFor(6), id: replacementBody.id });

      const renew = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${created[0]!.id}/resend`,
        {
          headers: { "Idempotency-Key": `seat-renew-${run}` },
          method: "POST",
        },
      );
      expect(renew.status).toBe(409);
      expect(errorCodeFrom(await renew.json())).toBe("seat_limit_reached");
    } finally {
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM workspace_invitations WHERE email LIKE $1", [
          `seat-limit-${run}-%`,
        ]),
      );
    }
  });

  it("allows a resend retry after a definitive mail failure", async () => {
    const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
    const run = lifecycleRunToken();
    const email = `resend-failure-${run}@meltiply.local`;
    const ownerIdentity = jwtIdentity({
      email: "alpha@meltiply.local",
      id: alpha.subject,
      name: "Alpha Creator",
    });
    let failSubmission = false;
    const { request, sent } = lifecycleInvitationHarness({
      identities: { owner: ownerIdentity },
      send: () =>
        failSubmission
          ? Effect.fail(
              new MailSubmissionError({
                classification: "rejected",
                message: "The mail service rejected the submission.",
              }),
            )
          : Effect.succeed({ submissionId: "test-submission-id" }),
    });

    const created = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
      body: JSON.stringify({ email, role: "viewer" }),
      headers: { "Idempotency-Key": `resend-failure-create-${run}` },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const invitationId = (await created.json<{ id: string }>()).id;

    try {
      const resendKey = `resend-failure-retry-${run}`;
      failSubmission = true;
      const resend = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${invitationId}/resend`,
        {
          headers: { "Idempotency-Key": resendKey },
          method: "POST",
        },
      );
      expect(resend.status).toBe(502);
      expect(errorCodeFrom(await resend.json())).toBe("email_delivery_failed");
      expect(sent).toHaveLength(2);

      // The failed resend keeps the invitation pending and drops its committed
      // idempotency record, so reusing the key can rotate and resend.
      const pending = await systemTransaction(env, (client) =>
        client.query<{ revoked_at: Date | string | null }>(
          "SELECT revoked_at FROM workspace_invitations WHERE id = $1",
          [invitationId],
        ),
      );
      expect(pending.rows[0]?.revoked_at).toBeNull();

      failSubmission = false;
      const retry = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${invitationId}/resend`,
        {
          headers: { "Idempotency-Key": resendKey },
          method: "POST",
        },
      );
      expect(retry.status).toBe(200);
      expect(sent).toHaveLength(3);
    } finally {
      await systemTransaction(env, (client) =>
        client.query("DELETE FROM workspace_invitations WHERE id = $1", [invitationId]),
      );
    }
  });

  it("protects the last admin and blocks owner self-removal", async () => {
    const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
    const run = lifecycleRunToken();
    const ownerIdentity = jwtIdentity({
      email: "alpha@meltiply.local",
      id: alpha.subject,
      name: "Alpha Creator",
    });
    const { request } = lifecycleInvitationHarness({ identities: { owner: ownerIdentity } });

    const removedBeta = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/members/10000000-0000-4000-8000-000000000002`,
      {
        headers: { "Idempotency-Key": `remove-beta-${run}` },
        method: "DELETE",
      },
    );
    expect(removedBeta.status).toBe(204);
    try {
      const demote = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/members/10000000-0000-4000-8000-000000000001`,
        {
          body: JSON.stringify({ role: "editor" }),
          headers: { "Idempotency-Key": `demote-owner-${run}` },
          method: "PATCH",
        },
      );
      expect(demote.status).toBe(409);
      expect(errorCodeFrom(await demote.json())).toBe("owner_role_required");

      const selfDelete = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/members/10000000-0000-4000-8000-000000000001`,
        {
          headers: { "Idempotency-Key": `remove-owner-${run}` },
          method: "DELETE",
        },
      );
      expect(selfDelete.status).toBe(409);
      expect(errorCodeFrom(await selfDelete.json())).toBe("owner_self_removal");
    } finally {
      await systemTransaction(env, (client) =>
        client.query(
          `INSERT INTO org_members (org_id, user_id, role)
           VALUES ($1, '10000000-0000-4000-8000-000000000002', 'admin')
           ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'`,
          [sharedWorkspaceId],
        ),
      );
    }
  });

  it("accepts an invitation through the link and hard-deletes the invited account", async () => {
    const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
    const run = lifecycleRunToken();
    const inviteEmail = `lifecycle-delete-${run}@meltiply.local`;
    const subject = `auth_user_lifecycle_delete_${run}`;
    const ownerIdentity = jwtIdentity({
      email: "alpha@meltiply.local",
      id: alpha.subject,
      name: "Alpha Creator",
    });
    const inviteeIdentity = jwtIdentity({
      email: inviteEmail,
      id: subject,
      name: "Delete Target",
    });
    const { request, sent } = lifecycleInvitationHarness({
      identities: { invitee: inviteeIdentity, owner: ownerIdentity },
    });

    const invited = await request(`/api/v1/workspaces/${sharedWorkspaceId}/invitations`, {
      body: JSON.stringify({ email: inviteEmail, role: "viewer" }),
      headers: { "Idempotency-Key": `delete-invite-${run}` },
      method: "POST",
    });
    expect(invited.status).toBe(201);
    const token = invitationTokenFrom(sent[0]!);

    await seedLifecycleUser(subject, inviteEmail, "Delete Target");
    const accepted = await request(
      `/api/v1/workspace-invitations/${token}/accept`,
      { method: "POST" },
      "invitee",
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json<{ member: { user_id: string } }>();
    const memberId = acceptedBody.member.user_id;

    const suspended = await request(`/api/v1/installation/members/${memberId}/suspend`, {
      body: JSON.stringify({ reason: "Test offboarding" }),
      headers: { "Idempotency-Key": `suspend-${run}` },
      method: "POST",
    });
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ status: "suspended" });

    const blocked = await request("/api/v1/users/me", { method: "GET" }, "invitee");
    expect(blocked.status).toBe(403);

    const reactivated = await request(`/api/v1/installation/members/${memberId}/reactivate`, {
      headers: { "Idempotency-Key": `reactivate-${run}` },
      method: "POST",
    });
    expect(reactivated.status).toBe(200);
    expect(await reactivated.json()).toMatchObject({ status: "active" });

    const deleted = await request(`/api/v1/installation/members/${memberId}`, {
      body: JSON.stringify({ confirm_email: inviteEmail }),
      headers: { "Idempotency-Key": `delete-${run}` },
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const remaining = await systemTransaction(env, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE auth_user_id = $1",
        [subject],
      ),
    );
    expect(remaining.rows[0]?.count).toBe("0");
  });
  it("builds the multi-chart dashboard aggregates with delta series and format breakdowns", async () => {
    const start = new Date("2026-07-01T00:00:00Z");
    const end = new Date("2026-07-31T23:59:59Z");
    const dashboard = await Effect.runPromise(
      service.dashboardAnalytics(env, alpha, { end, start }),
    );
    expect(dashboard.range).toEqual({
      end: end.toISOString(),
      start: start.toISOString(),
    });
    expect(Array.isArray(dashboard.series)).toBe(true);
    expect(Array.isArray(dashboard.best_times)).toBe(true);
    expect(Array.isArray(dashboard.formats)).toBe(true);
    expect(Array.isArray(dashboard.platforms)).toBe(true);
    expect(Array.isArray(dashboard.accumulation)).toBe(true);
    expect(dashboard.unavailable_metrics).toContain("saves");
    expect(dashboard.unavailable_metrics).toContain("clicks");

    // Format filtering narrows the cohort to matching attachment configurations.
    const videosOnly = await Effect.runPromise(
      service.dashboardAnalytics(env, alpha, { end, format: "video", start }),
    );
    expect(videosOnly.formats.every((row) => row.format === "video")).toBe(true);
  });
});
