import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { StorageUnavailableError } from "@meltiply/domain";
import type { StorageServiceShape } from "@meltiply/storage";
import { Cause, Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeEnv, fakeStorageService, fakeTransactionClient } from "../test-support/fakes";

const database = vi.hoisted(() => ({
  activeOrganizationIdEffect: vi.fn(),
  withSystemTransactionEffect: vi.fn(),
  withTenantTransactionEffect: vi.fn(),
}));
vi.mock("../src/database", () => database);

import { createAssetApiService } from "../src/asset-service";
import { CoreApiError } from "../src/api-errors";
import { createDistributionMethods } from "../src/distribution-service";
import { createPostApiService } from "../src/post-service";

const organizationId = "00000000-0000-4000-8000-000000000001";
const brandProfileId = "00000000-0000-4000-8000-000000000002";
const postId = "00000000-0000-4000-8000-000000000003";
const queueId = "00000000-0000-4000-8000-000000000004";
const distributionId = "00000000-0000-4000-8000-000000000005";
const accountId = "00000000-0000-4000-8000-000000000006";
const assetId = "00000000-0000-4000-8000-000000000007";
const sessionId = "00000000-0000-4000-8000-000000000008";
const env = fakeEnv();
const claims = (organizationRole: string): SessionClaims => ({
  subject: "publishing-actor",
  userId: "00000000-0000-4000-8000-000000000009",
  organizationId,
  organizationRole,
});

type PlatformCapability = components["schemas"]["PlatformCapability"];
type Row = Record<string, unknown>;
type Reply = Row[] | { rows: Row[]; rowCount: number } | undefined;
type Statement = { sql: string; params: readonly unknown[] };

function scriptDatabase(answer: (sql: string, params: readonly unknown[]) => Reply) {
  const statements: Statement[] = [];
  const client = fakeTransactionClient(
    vi.fn((sql: string, params: readonly unknown[] = []) =>
      Effect.sync(() => {
        statements.push({ sql, params });
        const reply = sql.includes("INSERT INTO idempotency_keys")
          ? [{ idempotency_key: "key" }]
          : answer(sql, params);
        const rows = Array.isArray(reply) ? reply : (reply?.rows ?? []);
        const rowCount = Array.isArray(reply) ? reply.length : (reply?.rowCount ?? 0);
        return { rows, rowCount };
      }),
    ),
  );
  const transaction = (...args: unknown[]) =>
    (args.at(-1) as (tx: typeof client) => unknown)(client);
  database.withTenantTransactionEffect.mockImplementation(transaction);
  database.withSystemTransactionEffect.mockImplementation(transaction);
  database.activeOrganizationIdEffect.mockImplementation(() => Effect.succeed(organizationId));
  return statements;
}

async function failure(program: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(program);
  if (!Exit.isFailure(exit)) throw new Error("Expected the program to fail");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  if (!(error instanceof CoreApiError)) throw new Error("Expected a typed CoreApiError");
  return error;
}

const postRow = (patch: Row = {}): Row => ({
  id: postId,
  org_id: organizationId,
  brand_profile_id: brandProfileId,
  title: "Launch",
  default_text: "Launch day",
  status: "active",
  revision: 2,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  queue_membership: null,
  ...patch,
});

const threadsCapability: PlatformCapability = {
  platform: "threads",
  accepted_mime_types: [],
  analytics: false,
  asset_types: [],
  comments: false,
  connect_available: true,
  max_caption_length: null,
  max_file_size: null,
  max_hashtags: null,
  max_media_count: null,
  max_video_duration_sec: null,
  min_media_count: 0,
  multi_asset_types: [],
  notes: [],
  publish: true,
  reply: false,
};

beforeEach(() => {
  database.activeOrganizationIdEffect.mockReset();
  database.withSystemTransactionEffect.mockReset();
  database.withTenantTransactionEffect.mockReset();
});

describe("Post composition", () => {
  it("rejects an empty new Post as a typed validation failure", async () => {
    scriptDatabase((sql) => (sql.includes("FROM brand_profiles") ? [{ deleted_at: null }] : []));
    const error = await failure(
      createPostApiService().createPost(
        env,
        claims("editor"),
        { brandProfileId, defaultText: "  " },
        "create-empty",
      ),
    );
    expect(error).toMatchObject({ status: 422, code: "validation_error" });
  });

  it("keeps a Post with an in-flight cancellation behind the Admin delete gate", async () => {
    const statements = scriptDatabase((sql, params) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("FROM posts")) return [postRow()];
      if (sql.includes("SELECT EXISTS")) {
        const statuses = Array.isArray(params[1]) ? (params[1] as string[]) : [];
        const listed = statuses.includes("cancel_requested") || sql.includes("'cancel_requested'");
        return [{ exists: listed }];
      }
      return [];
    });
    const error = await failure(
      createPostApiService().deletePost(
        env,
        claims("editor"),
        postId,
        { brandProfileId },
        "delete-in-flight",
      ),
    );
    expect(error).toMatchObject({ status: 403, code: "workspace_admin_required" });
    expect(statements.some(({ sql }) => sql.includes("UPDATE posts"))).toBe(false);
  });

  it("stops automatic retries of a deleted Post's failed publications", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("UPDATE posts")) return [postRow({ status: "active" })];
      if (sql.includes("FROM posts")) return [postRow()];
      return [];
    });
    await Effect.runPromise(
      createPostApiService().deletePost(
        env,
        claims("admin"),
        postId,
        { brandProfileId },
        "delete-failed",
      ),
    );
    expect(
      statements.some(
        ({ sql }) => /SET next_attempt_at = NULL/.test(sql) && /status = 'failed'/.test(sql),
      ),
    ).toBe(true);
  });

  it("issues a new publish command when republishing a cancelled Distribution", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("UPDATE posts")) return [postRow()];
      if (sql.includes("FOR UPDATE") && sql.includes("FROM posts")) return [postRow()];
      if (sql.includes("FROM post_targets"))
        return [
          {
            platform_account_id: accountId,
            title_override: null,
            description_override: null,
            hashtags: [],
            provider_options: null,
            signature_text: null,
            attachment_ids: null,
          },
        ];
      if (sql.includes("AS provider_owned"))
        return [
          {
            id: distributionId,
            platform_account_id: accountId,
            status: "cancelled",
            provider_owned: false,
          },
        ];
      if (sql.includes("FROM platform_accounts"))
        return [
          {
            id: accountId,
            account_brand_profile_id: brandProfileId,
            platform: "threads",
            connection_status: "connected",
            revoked_at: null,
            token_expires_at: null,
          },
        ];
      if (sql.includes("UPDATE distributions AS distribution")) return [{ id: distributionId }];
      return [];
    });
    await Effect.runPromise(
      createPostApiService([threadsCapability]).schedulePost(
        env,
        claims("editor"),
        postId,
        { brandProfileId, scheduledAt: null },
        "republish-now",
      ),
    );
    const command = statements.find(({ sql }) => sql.includes("INSERT INTO outbox_events"));
    const dedupeKeys = command?.params[3] as string[];
    expect(dedupeKeys).toHaveLength(1);
    expect(dedupeKeys[0]).not.toBe(
      "distribution:" + distributionId + ":distribution.publish.requested",
    );
  });
});

describe("Distribution retry", () => {
  it("refuses to republish a Distribution whose Post was deleted", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("SELECT brand_profile_id") || sql.includes("post_active"))
        return [{ brand_profile_id: brandProfileId, post_active: false }];
      if (sql.includes("UPDATE distributions"))
        return [
          {
            id: distributionId,
            org_id: organizationId,
            brand_profile_id: brandProfileId,
            post_id: postId,
            platform: "threads",
            status: "queued",
            attempt_count: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      return [];
    });
    const error = await failure(
      createDistributionMethods().retryDistribution(
        env,
        claims("editor"),
        distributionId,
        "retry-deleted",
      ),
    );
    expect(error).toMatchObject({ status: 409, code: "distribution_not_retryable" });
    expect(statements.some(({ sql }) => sql.includes("UPDATE distributions"))).toBe(false);
  });
});

const sessionRow = (patch: Row = {}): Row => ({
  id: sessionId,
  org_id: organizationId,
  asset_id: assetId,
  strategy: "single",
  status: "uploading",
  content_type: "image/png",
  file_size: 10,
  object_key: "staging/object.png",
  multipart_upload_id: null,
  part_size: null,
  part_count: null,
  max_parallel_parts: null,
  expires_at: "2099-01-01T00:00:00.000Z",
  ...patch,
});

describe("Upload session lifecycle", () => {
  it("claims the session before deleting the staged object", async () => {
    const order: string[] = [];
    const statements = scriptDatabase((sql) => {
      if (sql.includes("UPDATE asset_upload_sessions") && sql.includes("'aborted'"))
        order.push("claimed");
      if (sql.includes("FROM asset_upload_sessions")) return [sessionRow()];
      if (sql.includes("FROM assets")) return [{ status: "uploading" }];
      return { rows: [], rowCount: 1 };
    });
    const storageService = fakeStorageService({
      delete: () =>
        Effect.sync(() => {
          order.push("deleted");
        }),
    });
    await Effect.runPromise(
      createAssetApiService({ storageService }).abortUploadSession(
        env,
        claims("editor"),
        sessionId,
        "abort-claim",
      ),
    );
    expect(order[0]).toBe("claimed");
    expect(order).toContain("deleted");
    expect(statements.length).toBeGreaterThan(0);
  });

  it("arms the orphan clock when storage cannot finalize an upload", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM asset_upload_sessions")) return [sessionRow()];
      if (sql.includes("FROM assets")) return [{ status: "uploading" }];
      return { rows: [], rowCount: 1 };
    });
    const storageService = fakeStorageService({
      head: () => Effect.fail(new StorageUnavailableError({ message: "storage offline" })),
    });
    const error = await failure(
      createAssetApiService({ storageService }).completeUploadSession(
        env,
        claims("editor"),
        sessionId,
        { parts: [] },
        "complete-storage-failure",
      ),
    );
    expect(error).toMatchObject({ status: 502, code: "storage_unavailable" });
    expect(
      statements.some(
        ({ sql }) =>
          sql.includes("UPDATE assets") &&
          sql.includes("'failed'") &&
          sql.includes("orphan_delete_after"),
      ),
    ).toBe(true);
  });

  it("does not leave an Asset processing when its staged object is gone", async () => {
    let assetStatus = "uploading";
    const statements = scriptDatabase((sql) => {
      if (sql.includes("UPDATE assets") && sql.includes("'processing'")) {
        if (/EXISTS \(\s*SELECT 1 FROM asset_objects/.test(sql)) return { rows: [], rowCount: 0 };
        assetStatus = "processing";
        return {
          rows: [
            {
              id: assetId,
              org_id: organizationId,
              brand_profile_id: brandProfileId,
              asset_type: "image",
              status: "processing",
              title: "Image",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              file_size: 10,
              duration_sec: null,
              height: null,
              width: null,
              failure_at: null,
              failure_code: null,
              failure_message: null,
              failure_retryable: null,
              mime_type: "image/png",
              uploaded_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE assets") && sql.includes("'failed'")) {
        assetStatus = "failed";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE asset_objects")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM asset_upload_sessions")) return [sessionRow()];
      if (sql.includes("FROM assets")) return [{ status: "uploading" }];
      return { rows: [], rowCount: 1 };
    });
    const storageService = fakeStorageService({
      head: () =>
        Effect.succeed({
          contentType: "image/png",
          etag: "etag",
          key: "staging/object.png",
          size: 10,
          uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
          version: null,
        }),
    });
    const error = await failure(
      createAssetApiService({ storageService }).completeUploadSession(
        env,
        claims("editor"),
        sessionId,
        { parts: [] },
        "complete-lost-staging",
      ),
    );
    expect(error).toMatchObject({ status: 422, code: "missing_object" });
    expect(assetStatus).toBe("failed");
    expect(
      statements.some(
        ({ sql, params }) => sql.includes("UPDATE idempotency_keys") && params[3] === 422,
      ),
    ).toBe(true);
  });
});

const distributionRow = (patch: Row = {}): Row => ({
  id: distributionId,
  org_id: organizationId,
  brand_profile_id: brandProfileId,
  post_id: postId,
  platform_account_id: accountId,
  platform: "threads",
  status: "scheduled",
  scheduled_at: "2099-01-01T00:00:00.000Z",
  published_at: null,
  platform_post_id: null,
  platform_url: null,
  provider_operation_id: null,
  provider_warnings: null,
  title_override: null,
  description_override: null,
  hashtags: [],
  error_message: null,
  attempt_count: 0,
  last_attempt_at: null,
  next_attempt_at: null,
  failure_code: null,
  failure_retryable: null,
  batch_id: null,
  publication_snapshot: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const assetRow = (patch: Row = {}): Row => ({
  id: assetId,
  org_id: organizationId,
  brand_profile_id: brandProfileId,
  uploaded_by: null,
  asset_type: "image",
  title: "Image",
  duration_sec: null,
  file_size: "10",
  mime_type: "image/png",
  width: 100,
  height: "50",
  status: "ready",
  failure_code: null,
  failure_message: null,
  failure_retryable: null,
  failure_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("Distribution lifecycle", () => {
  const methods = createDistributionMethods();

  it("lists with parameterized filters and reports another page", async () => {
    const statements = scriptDatabase((sql) =>
      sql.includes("FROM distributions")
        ? [distributionRow(), distributionRow({ id: "00000000-0000-4000-8000-000000000011" })]
        : [],
    );
    const page = await Effect.runPromise(
      methods.listDistributions(env, claims("viewer"), {
        brandProfileId,
        platform: "threads",
        status: "scheduled",
        limit: 1,
        offset: 0,
      }),
    );
    expect(page.has_more).toBe(true);
    expect(page.distributions).toHaveLength(1);
    expect(statements[0]?.params).toEqual([brandProfileId, "scheduled", "threads", 2, 0]);
  });

  it("hides a missing Distribution", async () => {
    scriptDatabase(() => []);
    expect(
      await failure(methods.getDistribution(env, claims("viewer"), distributionId)),
    ).toMatchObject({ status: 404, code: "not_found" });
  });

  it("projects a live broadcast reference and failure details", async () => {
    scriptDatabase(() => [
      distributionRow({
        status: "failed",
        provider_operation_id: "live:broadcast",
        error_message: "Provider refused",
        failure_retryable: true,
      }),
    ]);
    await expect(
      Effect.runPromise(methods.getDistribution(env, claims("viewer"), distributionId)),
    ).resolves.toMatchObject({
      provider_reference: "live:broadcast",
      failure: { code: "distribution_failed", message: "Provider refused", retryable: true },
    });
  });

  it("cancels pending work immediately and drops its unleased commands", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FOR UPDATE")) return [{ status: "scheduled", publication_snapshot: null }];
      if (sql.includes("UPDATE distributions")) return [distributionRow({ status: "cancelled" })];
      return [];
    });
    const result = await Effect.runPromise(
      methods.cancelDistribution(env, claims("editor"), distributionId, "cancel-pending"),
    );
    expect(result.status).toBe(204);
    expect(statements.some(({ sql }) => sql.includes("DELETE FROM outbox_events"))).toBe(true);
  });

  it("requests cancellation of in-flight work through the outbox", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FOR UPDATE")) return [{ status: "processing", publication_snapshot: null }];
      if (sql.includes("UPDATE distributions"))
        return [distributionRow({ status: "cancel_requested" })];
      return [];
    });
    const result = await Effect.runPromise(
      methods.cancelDistribution(env, claims("editor"), distributionId, "cancel-flight"),
    );
    expect(result.status).toBe(202);
    const command = statements.find(({ sql }) => sql.includes("INSERT INTO outbox_events"));
    expect(command?.params[1]).toEqual(["distribution.cancel.requested"]);
  });

  it("refuses to cancel a settled outcome", async () => {
    scriptDatabase((sql) =>
      sql.includes("FOR UPDATE") ? [{ status: "published", publication_snapshot: null }] : [],
    );
    expect(
      await failure(
        methods.cancelDistribution(env, claims("editor"), distributionId, "cancel-settled"),
      ),
    ).toMatchObject({ status: 409, code: "invalid_state" });
  });

  it("reschedules with a command for the new instant", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("post_active"))
        return [{ brand_profile_id: brandProfileId, post_id: postId, post_active: true }];
      if (sql.includes("UPDATE distributions")) return [distributionRow()];
      return [];
    });
    await Effect.runPromise(
      methods.updateDistribution(
        env,
        claims("editor"),
        distributionId,
        { scheduledAt },
        "reschedule",
      ),
    );
    const command = statements.find(({ sql }) => sql.includes("INSERT INTO outbox_events"));
    expect(command?.params[3]).toEqual([
      "distribution:" +
        distributionId +
        ":distribution.publish.requested:at:" +
        scheduledAt.getTime(),
    ]);
  });

  it("refuses manual rescheduling while a Queue owns the instant", async () => {
    scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("post_active"))
        return [{ brand_profile_id: brandProfileId, post_id: postId, post_active: true }];
      if (sql.includes("FROM publishing_queue_memberships"))
        return [
          { queue_id: queueId, queue_name: "Weekly", assigned_at: "2099-01-01T00:00:00.000Z" },
        ];
      return [];
    });
    expect(
      await failure(
        methods.updateDistribution(
          env,
          claims("editor"),
          distributionId,
          { scheduledAt: new Date(Date.now() + 60_000) },
          "reschedule-queued",
        ),
      ),
    ).toMatchObject({ status: 409, code: "queue_membership_exists" });
  });

  it("retries a failed Distribution with a command unique to the request", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("post_active"))
        return [{ brand_profile_id: brandProfileId, post_id: postId, post_active: true }];
      if (sql.includes("UPDATE distributions")) return [distributionRow({ status: "queued" })];
      return [];
    });
    const result = await Effect.runPromise(
      methods.retryDistribution(env, claims("editor"), distributionId, "retry-live"),
    );
    expect(result.value.status).toBe("queued");
    const command = statements.find(({ sql }) => sql.includes("INSERT INTO outbox_events"));
    const keys = command?.params[3] as string[] | undefined;
    expect(keys?.[0]).toContain(":retry:");
  });
});

describe("Post reads and drafts", () => {
  const service = createPostApiService([threadsCapability]);

  it("hides a missing Post", async () => {
    scriptDatabase(() => []);
    expect(await failure(service.getPost(env, claims("viewer"), postId))).toMatchObject({
      status: 404,
      code: "post_not_found",
    });
  });

  it("sums the latest analytics across published Channels", async () => {
    scriptDatabase((sql) => {
      if (sql.includes("JOIN LATERAL"))
        return [
          {
            post_id: postId,
            distribution_id: distributionId,
            platform: "threads",
            likes: "2",
            comments: 1,
            shares: 0,
            views: "10",
            impressions: 12,
            reach: 9,
          },
        ];
      if (sql.includes("FROM distributions")) return [distributionRow({ status: "published" })];
      if (sql.includes("FROM posts")) return [postRow()];
      return [];
    });
    const post = await Effect.runPromise(service.getPost(env, claims("viewer"), postId));
    expect(post.analytics).toMatchObject({ likes: 2, views: 10, saves: null });
    expect(post.distribution_analytics).toHaveLength(1);
  });

  it("filters a Queue window with bound parameters and reports another page", async () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-08T00:00:00.000Z");
    const statements = scriptDatabase((sql) =>
      sql.includes("FROM posts")
        ? [postRow(), postRow({ id: "00000000-0000-4000-8000-000000000012" })]
        : [],
    );
    const page = await Effect.runPromise(
      service.listPosts(env, claims("viewer"), {
        brandProfileId,
        queueId,
        queueWindow: { start, end },
        status: "active",
        limit: 1,
        offset: 0,
      }),
    );
    expect(page.has_more).toBe(true);
    expect(statements[0]?.params).toEqual(["active", brandProfileId, start, end, queueId, 2, 0]);
  });

  it("creates a draft with its saved Channel targets", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("FROM platform_accounts"))
        return [
          {
            id: accountId,
            account_brand_profile_id: brandProfileId,
            platform: "threads",
            connection_status: "connected",
            revoked_at: null,
            token_expires_at: null,
          },
        ];
      if (sql.includes("INSERT INTO posts")) return [postRow({ status: "draft" })];
      return [];
    });
    const result = await Effect.runPromise(
      service.createPost(
        env,
        claims("editor"),
        {
          brandProfileId,
          defaultText: "Launch day",
          targets: [{ platformAccountId: accountId, hashtags: ["launch"] }],
        },
        "create-draft",
      ),
    );
    expect(result.value.status).toBe("draft");
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO post_targets"))).toBe(true);
  });

  it("rejects a saved target for another Brand Profile's Channel", async () => {
    scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("FROM platform_accounts"))
        return [
          {
            id: accountId,
            account_brand_profile_id: "00000000-0000-4000-8000-000000000013",
            platform: "threads",
            connection_status: "connected",
            revoked_at: null,
            token_expires_at: null,
          },
        ];
      return [];
    });
    const error = await failure(
      service.createPost(
        env,
        claims("editor"),
        {
          brandProfileId,
          defaultText: "Launch day",
          targets: [{ platformAccountId: accountId }],
        },
        "foreign-channel",
      ),
    );
    expect(error).toMatchObject({ status: 422, code: "brand_profile_mismatch" });
  });

  it("updates a draft and advances its revision once", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("UPDATE posts")) return [postRow({ title: "Renamed", revision: 3 })];
      if (sql.includes("FROM posts")) return [postRow()];
      return [];
    });
    const result = await Effect.runPromise(
      service.updatePost(
        env,
        claims("editor"),
        postId,
        { brandProfileId, title: "Renamed" },
        "update-draft",
      ),
    );
    expect(result.value).toMatchObject({ title: "Renamed", revision: 3 });
    expect(statements.filter(({ sql }) => sql.includes("UPDATE posts"))).toHaveLength(1);
  });

  it("refuses edits across Brand Profiles", async () => {
    scriptDatabase((sql) => (sql.includes("FROM posts") ? [postRow()] : []));
    const error = await failure(
      service.updatePost(
        env,
        claims("editor"),
        postId,
        { brandProfileId: "00000000-0000-4000-8000-000000000014", title: "Moved" },
        "wrong-profile",
      ),
    );
    expect(error).toMatchObject({ status: 422, code: "brand_profile_mismatch" });
  });
});

describe("Asset reads and upload grants", () => {
  const storage = (patch: Partial<StorageServiceShape>) => fakeStorageService(patch);

  it("projects numeric facts and hides a missing Asset", async () => {
    const service = createAssetApiService({ storageService: storage({}) });
    scriptDatabase(() => [assetRow()]);
    await expect(
      Effect.runPromise(service.getAsset(env, claims("viewer"), assetId)),
    ).resolves.toMatchObject({ file_size: 10, height: 50, width: 100, failure: null });
    scriptDatabase(() => []);
    expect(await failure(service.getAsset(env, claims("viewer"), assetId))).toMatchObject({
      status: 404,
    });
  });

  it("signs a download of the protected original with its filename", async () => {
    const signDownload = vi.fn(() => Effect.succeed("https://signed.example/object"));
    const service = createAssetApiService({ storageService: storage({ signDownload }) });
    scriptDatabase((sql) => {
      if (sql.includes("FROM asset_objects")) return [{ r2_key: "originals/object.png" }];
      if (sql.includes("FROM assets"))
        return [
          {
            title: "Image",
            original_filename: "photo.png",
            status: "ready",
            asset_type: "image",
            mime_type: "image/png",
          },
        ];
      return [];
    });
    const result = await Effect.runPromise(
      service.getAssetDownloadUrl(env, claims("viewer"), assetId),
    );
    expect(result.url).toBe("https://signed.example/object");
    expect(signDownload).toHaveBeenCalledWith(
      expect.objectContaining({ downloadFilename: "photo.png", key: "originals/object.png" }),
    );
  });

  it("refuses a preview of unfinished media", async () => {
    const service = createAssetApiService({ storageService: storage({}) });
    scriptDatabase((sql) =>
      sql.includes("FROM assets")
        ? [
            {
              title: "Image",
              original_filename: "photo.png",
              status: "processing",
              asset_type: "image",
              mime_type: "image/png",
            },
          ]
        : [],
    );
    expect(await failure(service.getAssetPreviewUrl(env, claims("viewer"), assetId))).toMatchObject(
      { status: 409, code: "invalid_state" },
    );
  });

  it("creates a single-PUT session whose grant deadline is recorded first", async () => {
    const order: string[] = [];
    const signUpload = vi.fn(() =>
      Effect.sync(() => {
        order.push("signed");
        return "https://signed.example/upload";
      }),
    );
    const service = createAssetApiService({ storageService: storage({ signUpload }) });
    scriptDatabase((sql) => {
      if (sql.includes("AS active_reservation_bytes"))
        return [
          {
            id: organizationId,
            user_id: claims("editor").userId,
            uploads: 0,
            storage_bytes: 0,
            active_reservations: 0,
            active_reservation_bytes: 0,
          },
        ];
      if (sql.includes("FROM brand_profiles")) return [{ deleted_at: null }];
      if (sql.includes("INSERT INTO assets"))
        return [assetRow({ status: "pending_upload", file_size: null })];
      if (sql.includes("INSERT INTO asset_upload_sessions"))
        return [sessionRow({ status: "created" })];
      if (sql.includes("SET write_hold_until")) {
        order.push("recorded");
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await Effect.runPromise(
      service.createUploadSession(
        env,
        claims("editor"),
        {
          asset_type: "image",
          brand_profile_id: brandProfileId,
          content_type: "image/png",
          file_size: 10,
          filename: "photo.png",
          title: "Photo",
        },
        "create-upload",
      ),
    );
    expect(result.value.upload_session.single_upload?.url).toBe("https://signed.example/upload");
    expect(order).toEqual(["recorded", "signed"]);
  });

  it("rejects an unsupported media type as a typed failure", async () => {
    const service = createAssetApiService({ storageService: storage({}) });
    scriptDatabase(() => []);
    const error = await failure(
      service.createUploadSession(
        env,
        claims("editor"),
        {
          asset_type: "image",
          brand_profile_id: brandProfileId,
          content_type: "application/pdf",
          file_size: 10,
          filename: "file.pdf",
          title: "File",
        },
        "unsupported-upload",
      ),
    );
    expect(error).toMatchObject({ status: 415, code: "unsupported_media_type" });
  });

  it("expires an overdue session on read without minting a grant", async () => {
    const signUpload = vi.fn();
    const service = createAssetApiService({
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      storageService: storage({ signUpload }),
    });
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM asset_upload_sessions"))
        return [sessionRow({ expires_at: "2026-05-01T00:00:00.000Z" })];
      if (sql.includes("FROM assets")) return [assetRow({ status: "failed" })];
      return { rows: [], rowCount: 1 };
    });
    const detail = await Effect.runPromise(
      service.getUploadSession(env, claims("editor"), sessionId),
    );
    expect(detail.upload_session.status).toBe("expired");
    expect(signUpload).not.toHaveBeenCalled();
    expect(
      statements.some(
        ({ sql, params }) =>
          sql.includes("UPDATE assets") && params[1] === "upload_session_expired",
      ),
    ).toBe(true);
  });

  it("signs multipart part URLs after recording their deadline", async () => {
    const signMultipartPart = vi.fn(() => Effect.succeed("https://signed.example/part"));
    const service = createAssetApiService({ storageService: storage({ signMultipartPart }) });
    const multipart = sessionRow({
      strategy: "multipart",
      multipart_upload_id: "upload-id",
      file_size: 30,
      part_size: 10,
      part_count: 3,
      max_parallel_parts: 2,
    });
    scriptDatabase((sql) => {
      if (sql.includes("FROM asset_upload_sessions")) return [multipart];
      return { rows: [], rowCount: 1 };
    });
    const result = await Effect.runPromise(
      service.createUploadPartUrls(
        env,
        claims("editor"),
        sessionId,
        { part_numbers: [2, 1] },
        "part-urls",
      ),
    );
    expect(result.parts.map((part) => part.part_number)).toEqual([1, 2]);
    expect(signMultipartPart).toHaveBeenCalledTimes(2);
  });

  it("rejects a part outside the multipart layout", async () => {
    const service = createAssetApiService({ storageService: storage({}) });
    scriptDatabase((sql) =>
      sql.includes("FROM asset_upload_sessions")
        ? [
            sessionRow({
              strategy: "multipart",
              multipart_upload_id: "upload-id",
              file_size: 30,
              part_size: 10,
              part_count: 3,
              max_parallel_parts: 2,
            }),
          ]
        : [],
    );
    expect(
      await failure(
        service.createUploadPartUrls(
          env,
          claims("editor"),
          sessionId,
          { part_numbers: [4] },
          "invalid-part",
        ),
      ),
    ).toMatchObject({ status: 422, code: "invalid_part_list" });
  });

  it("finalizes a verified upload and requests processing", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("UPDATE assets") && sql.includes("'processing'"))
        return { rows: [assetRow({ status: "processing" })], rowCount: 1 };
      if (sql.includes("FROM asset_upload_sessions")) return [sessionRow()];
      if (sql.includes("FROM assets")) return [{ status: "uploading" }];
      return { rows: [], rowCount: 1 };
    });
    const storageService = storage({
      head: () =>
        Effect.succeed({
          contentType: "image/png",
          etag: "etag",
          key: "staging/object.png",
          size: 10,
          uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
          version: "v1",
        }),
    });
    const result = await Effect.runPromise(
      createAssetApiService({ storageService }).completeUploadSession(
        env,
        claims("editor"),
        sessionId,
        { parts: [] },
        "complete-verified",
      ),
    );
    expect(result.value?.status).toBe("processing");
    expect(
      statements.some(
        ({ sql }) =>
          sql.includes("INSERT INTO outbox_events") && sql.includes("asset.processing.requested"),
      ),
    ).toBe(true);
  });

  it("fails a size mismatch and reclaims the staged bytes", async () => {
    const statements = scriptDatabase((sql) => {
      if (sql.includes("FROM asset_upload_sessions")) return [sessionRow()];
      if (sql.includes("FROM assets")) return [{ status: "uploading" }];
      return { rows: [], rowCount: 1 };
    });
    const storageService = storage({
      head: () =>
        Effect.succeed({
          contentType: "image/png",
          etag: "etag",
          key: "staging/object.png",
          size: 11,
          uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
    });
    const error = await failure(
      createAssetApiService({ storageService }).completeUploadSession(
        env,
        claims("editor"),
        sessionId,
        { parts: [] },
        "complete-mismatch",
      ),
    );
    expect(error).toMatchObject({ status: 422, code: "metadata_mismatch" });
    expect(statements.some(({ sql }) => sql.includes("SET status = 'deleting'"))).toBe(true);
  });

  it("refuses to abort a completed upload", async () => {
    scriptDatabase((sql) =>
      sql.includes("FROM asset_upload_sessions") ? [sessionRow({ status: "completed" })] : [],
    );
    const service = createAssetApiService({ storageService: storage({}) });
    expect(
      await failure(service.abortUploadSession(env, claims("editor"), sessionId, "abort-complete")),
    ).toMatchObject({ status: 409, code: "invalid_state" });
  });
});
