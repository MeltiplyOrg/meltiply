import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Effect, Schema } from "effect";
import { DatabaseError, INSTALLATION_SEAT_LIMIT } from "../../packages/domain/src/index";
import { ProviderRegistry } from "../../packages/providers/src/index";
import type { EffectTransactionClient } from "../../packages/database/src/index";
import { assemblePostsEffect } from "../../workers/api/src/post-service";
import { mapAsset } from "../../workers/api/src/asset-types";
import { createCoreApiService, mapSnapshot } from "../../workers/api/src/core-service";
import { mapQueue } from "../../workers/api/src/publishing-queue-store";
import { seatUsageEffect } from "../../workers/api/src/seats";
import {
  previewObjectSchema,
  type PreviewObject,
  type PreviewValue,
} from "../../frontend/app/src/preview/contract-types";

const seedPath = fileURLToPath(
  new URL("../../scripts/cloudflare-local/postgres/seed.sql", import.meta.url),
);
const migrationDirectory = fileURLToPath(
  new URL("../../packages/database/migrations/", import.meta.url),
);
const decodeObject = Schema.decodeUnknownSync(previewObjectSchema);

interface SeedSnapshot {
  responses: Record<string, PreviewValue>;
  fixtures: PreviewObject;
}

/** Evaluates the actual migrations and seed.sql in disposable build-process memory, under the seeded Owner's tenant role. Reuses production read projections, exports only public JSON, closes Postgres on every exit, and never opens a network listener or reads live database configuration. */
async function compileSeedSnapshot(): Promise<SeedSnapshot> {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE ROLE meltiply_system BYPASSRLS; CREATE ROLE meltiply_rls; SET timezone = 'UTC';",
    );
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrations)
      await db.exec(await readFile(join(migrationDirectory, name), "utf8"));
    await db.exec(await readFile(seedPath, "utf8"));
    /** Serializes explicit projection columns; to_jsonb retains SQL-generated arrays and timestamps without exporting driver objects or private credential tables. */
    async function rows(sql: string, values: unknown[] = []): Promise<PreviewObject[]> {
      const result = await db.query<{ value: unknown }>(
        `SELECT to_jsonb(seed_row) AS value FROM (${sql}) AS seed_row`,
        values,
      );
      return result.rows.map((row) => decodeObject(row.value));
    }
    const [owner] =
      await rows(`SELECT u.id, u.auth_user_id, u.email, u.display_name, u.avatar_url, u.installation_owner,
      u.created_at, u.updated_at, w.id AS org_id, w.name AS workspace_name, w.slug AS workspace_slug, membership.role
      FROM users u JOIN org_members membership ON membership.user_id = u.id
      JOIN organizations w ON w.id = membership.org_id
      WHERE u.installation_owner AND w.is_shared`);
    if (
      !owner ||
      typeof owner.id !== "string" ||
      typeof owner.org_id !== "string" ||
      typeof owner.auth_user_id !== "string" ||
      typeof owner.role !== "string"
    )
      throw new Error(
        "The canonical seed must contain one Installation Owner in the shared Workspace",
      );
    const orgId = owner.org_id;
    const claims = {
      subject: owner.auth_user_id,
      userId: owner.id,
      organizationId: orgId,
      organizationRole: owner.role,
    };
    await db.exec("BEGIN");
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: claims.subject, org_id: orgId, org_role: claims.organizationRole }),
    ]);
    await db.exec("SET LOCAL ROLE meltiply_rls");
    const client: EffectTransactionClient = {
      query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
        Effect.tryPromise({
          try: async () => {
            const result = await db.query<Row>(text, values ? [...values] : []);
            return {
              rows: result.rows,
              rowCount: result.rows.length,
              command: "SELECT",
              fields: [],
              oid: 0,
            };
          },
          catch: (cause) =>
            new DatabaseError({
              cause,
              message: cause instanceof Error ? cause.message : "Seed projection query failed",
            }),
        }),
    };
    const now = new Date();
    const env = { ENVIRONMENT: "test" as const, VERSION: "ui-preview-seed" };
    const capabilities = new ProviderRegistry().capabilities();
    const core = createCoreApiService(capabilities, {
      now: () => now,
      tenantTransaction: (_env, _claims, operation) => operation(client),
    });
    const postRows = await db.query<Parameters<typeof assemblePostsEffect>[1][number]>(
      `SELECT posts.*,
      (SELECT jsonb_build_object('queue_id', membership.queue_id, 'queue_name', membership.queue_name, 'assigned_at', membership.assigned_at)
       FROM publishing_queue_memberships membership WHERE membership.post_id = posts.id AND membership.released_at IS NULL) AS queue_membership
      FROM posts WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
      [orgId],
    );
    const posts = await Effect.runPromise(assemblePostsEffect(client, postRows.rows));
    const assetRows = await db.query<Parameters<typeof mapAsset>[0]>(
      "SELECT * FROM assets WHERE org_id = $1 ORDER BY id",
      [orgId],
    );
    const assets = assetRows.rows.map(mapAsset);
    const accounts = await Effect.runPromise(core.listPlatformAccounts(env, claims));
    const profiles = await rows(
      "SELECT id, org_id, name, description, color, deleted_at, purge_at, created_at, updated_at FROM brand_profiles WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at, id",
      [orgId],
    );
    const queueRows = await db.query<Parameters<typeof mapQueue>[0]>(
      "SELECT * FROM publishing_queues WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at, id",
      [orgId],
    );
    const queues = queueRows.rows.map(mapQueue);
    const snapshotRows = await db.query<Parameters<typeof mapSnapshot>[0]>(
      `SELECT snapshot.*, distribution.post_id
      FROM analytics_snapshots snapshot JOIN distributions distribution ON distribution.id = snapshot.distribution_id
      WHERE snapshot.org_id = $1 ORDER BY snapshot.snapshot_at, snapshot.id`,
      [orgId],
    );
    const snapshots = snapshotRows.rows.map(mapSnapshot);
    const range = { start: new Date(now.getTime() - 30 * 86400000), end: now };
    const summary = await Effect.runPromise(core.summaryAnalytics(env, claims, range));
    const dashboard = await Effect.runPromise(core.dashboardAnalytics(env, claims, range));
    const analyticsPosts = await Effect.runPromise(
      core.analyticsPosts(env, claims, { ...range, limit: 1000, offset: 0, metric: "views" }),
    );
    const calendar = await Effect.runPromise(
      core.calendar(
        env,
        claims,
        new Date(now.getTime() - 366 * 86400000),
        new Date(now.getTime() + 90 * 86400000),
        5000,
      ),
    );
    const seatUsage = await Effect.runPromise(seatUsageEffect(client, orgId));
    const members = await rows(
      `SELECT u.id AS user_id, u.email, u.display_name, u.avatar_url, membership.role,
      CASE WHEN u.suspended_at IS NULL THEN 'active' ELSE 'suspended' END AS status,
      u.installation_owner AS is_installation_owner, u.suspended_at, membership.created_at, membership.updated_at
      FROM org_members membership JOIN users u ON u.id = membership.user_id WHERE membership.org_id = $1 ORDER BY membership.created_at, u.id`,
      [orgId],
    );
    const invitations = await rows(
      `SELECT id, org_id, email, role, expires_at,
      CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at < now() THEN 'expired' ELSE 'pending' END AS status,
      created_at, updated_at FROM workspace_invitations WHERE org_id = $1 ORDER BY created_at DESC, id`,
      [orgId],
    );
    const entries = await rows(
      `SELECT id, jsonb_build_object('email', actor_email, 'display_name', actor_display_name) AS actor,
      action, target_type, target_id, before_state AS before, after_state AS after, request_id, created_at
      FROM workspace_audit_entries WHERE org_id = $1 ORDER BY created_at DESC, id DESC`,
      [orgId],
    );
    const [workspace] = await rows(
      "SELECT id, name, slug, created_at, updated_at FROM organizations WHERE id = $1",
      [orgId],
    );
    const currentUser = {
      id: owner.id,
      email: owner.email,
      display_name: owner.display_name,
      avatar_url: owner.avatar_url,
      active_organization: {
        id: orgId,
        name: owner.workspace_name,
        slug: owner.workspace_slug,
        role: owner.role,
      },
      is_installation_owner: owner.installation_owner,
      created_at: owner.created_at,
      updated_at: owner.updated_at,
    };
    const authUser = {
      id: owner.auth_user_id,
      email: owner.email,
      name: owner.display_name,
      emailVerified: true,
      image: owner.avatar_url,
      createdAt: owner.created_at,
      updatedAt: owner.updated_at,
    };
    const session = {
      id: "ui-preview-session",
      userId: owner.auth_user_id,
      token: "ui-preview-synthetic-session",
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ipAddress: null,
      userAgent: null,
    };
    const distributions = posts.flatMap((post) => post.distributions);
    const responseBodies = {
      getCurrentUser: currentUser,
      getAuthSession: { user: authUser, session },
      signInWithEmail: {
        user: authUser,
        token: "ui-preview-synthetic-session",
        redirect: false,
        url: null,
      },
      signUpWithEmail: { user: authUser, token: "ui-preview-synthetic-session" },
      verifyTotp: { user: authUser, token: "ui-preview-synthetic-session" },
      verifyBackupCode: { user: authUser, token: "ui-preview-synthetic-session" },
      listBrandProfiles: { profiles },
      getBrandProfile: profiles[0],
      listPlatformCapabilities: { capabilities },
      listPlatformAccounts: { accounts },
      listQueues: { items: queues, next_cursor: null },
      getQueue: queues[0],
      listPosts: { posts, limit: 60, offset: 0, has_more: posts.length > 60 },
      getPost: posts[0],
      createPost: {
        ...posts[0],
        title: "",
        default_text: "",
        status: "draft",
        attachments: [],
        targets: [],
        distributions: [],
        analytics: null,
        distribution_analytics: [],
        queue_membership: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      listDistributions: { distributions, limit: 100, offset: 0, has_more: false },
      getDistribution: distributions[0],
      getAsset: assets[0],
      listCalendarEvents: { events: calendar },
      getAnalyticsSummary: summary,
      getAnalyticsPosts: analyticsPosts,
      getAnalyticsDashboard: dashboard,
      getDistributionAnalytics: { snapshots },
      listWorkspaceMembers: { members },
      listWorkspaceInvitations: { invitations },
      listWorkspaceAudit: { entries, has_more: false, limit: 100, offset: 0 },
      getInstallation: {
        installation_owner_user_id: owner.id,
        seat_limit: INSTALLATION_SEAT_LIMIT,
        seats_used: seatUsage.used,
        members_active: seatUsage.activeMembers,
        invitations_pending: seatUsage.pendingInvitations,
        workspace: { ...workspace, role: owner.role },
      },
      getWorkspaceInvitation: {
        email: invitations[0]?.email,
        role: invitations[0]?.role,
        status: invitations[0]?.status,
        expires_at: invitations[0]?.expires_at,
        workspace_name: owner.workspace_name,
      },
    };
    await db.exec("COMMIT");
    return {
      responses: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
        JSON.parse(JSON.stringify(responseBodies)),
      ),
      fixtures: decodeObject(
        JSON.parse(
          JSON.stringify({
            asset: assets[0],
            assets,
          }),
        ),
      ),
    };
  } finally {
    await db.close();
  }
}

try {
  process.stdout.write(JSON.stringify(await compileSeedSnapshot()));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Could not compile the canonical development seed",
  );
  process.exitCode = 1;
}
