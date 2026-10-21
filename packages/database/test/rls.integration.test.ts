import { Cause, Effect, Option } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireClient,
  createDatabaseServiceLive,
  createDatabaseServiceTest,
  createHyperdrivePool,
  DatabaseService,
  destroyClientsOnRelease,
  serializeAuthenticatedClaims,
  withAuthenticatedTransactionEffect,
  withTransactionEffect,
  type EffectTransactionClient,
} from "../src/index";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for the RLS integration suite");
}

const pool = createHyperdrivePool({ connectionString }, { max: 2 });

afterAll(async () => {
  await pool.end();
});

// Seeded identities (scripts/cloudflare-local/postgres/seed.sql): Better Auth
// subjects auth_user_local_alpha/beta map to internal users 10000000-…-1/2,
// team workspaces 20000000-…-1/2, and one personal workspace per user.
const alphaSubject = "auth_user_local_alpha";
const betaSubject = "auth_user_local_beta";
const alphaUserId = "10000000-0000-4000-8000-000000000001";
const alphaOrgId = "20000000-0000-4000-8000-000000000001";
const betaOrgId = "20000000-0000-4000-8000-000000000002";
const alphaAssetId = "40000000-0000-4000-8000-000000000001";
const betaAssetId = "40000000-0000-4000-8000-000000000002";

describe("PostgreSQL authenticated-role tenant isolation", () => {
  it("exposes only the active workspace", async () => {
    const alpha = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: alphaOrgId, sub: alphaSubject },
        (client) =>
          client.query<{ id: string; org_id: string }>("SELECT id, org_id FROM assets ORDER BY id"),
      ),
    );
    const beta = await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, { org_id: betaOrgId, sub: betaSubject }, (client) =>
        client.query<{ id: string; org_id: string }>("SELECT id, org_id FROM assets ORDER BY id"),
      ),
    );

    expect(alpha.rows).toEqual([{ id: alphaAssetId, org_id: alphaOrgId }]);
    expect(beta.rows).toEqual([{ id: betaAssetId, org_id: betaOrgId }]);
  });

  it("rejects a cross-tenant write", async () => {
    const exit = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: alphaOrgId, sub: alphaSubject },
        (client) =>
          client.query(
            `INSERT INTO assets (
               org_id, uploaded_by, asset_type, title, status
             )
             VALUES ($1, $2, 'image', 'forbidden', 'ready')`,
            [betaOrgId, alphaUserId],
          ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "DatabaseError" });
        // RLS surfaces as PostgreSQL insufficient_privilege (42501).
        expect((failure.value as { cause?: { code?: string } }).cause).toMatchObject({
          code: "42501",
        });
      }
    }
  });

  it("scopes authenticated statement timeout to the transaction", async () => {
    const beforeClient = await pool.connect();
    let statementTimeoutBefore: string;
    try {
      const result = await beforeClient.query<{ statement_timeout: string }>(
        "SELECT current_setting('statement_timeout') AS statement_timeout",
      );
      statementTimeoutBefore = result.rows[0]?.statement_timeout ?? "";
      expect(statementTimeoutBefore).not.toBe("10s");
    } finally {
      beforeClient.release();
    }

    await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: alphaOrgId, sub: alphaSubject },
        (client) =>
          Effect.gen(function* () {
            const result = yield* client.query<{
              statement_timeout: string;
            }>("SELECT current_setting('statement_timeout') AS statement_timeout");
            expect(result.rows[0]?.statement_timeout).toBe("10s");
          }),
      ),
    );

    const afterClient = await pool.connect();
    try {
      const result = await afterClient.query<{ statement_timeout: string }>(
        "SELECT current_setting('statement_timeout') AS statement_timeout",
      );
      expect(result.rows[0]?.statement_timeout).toBe(statementTimeoutBefore);
    } finally {
      afterClient.release();
    }
  });

  it("does not leak transaction-local claims through the pool", async () => {
    await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: alphaOrgId, sub: alphaSubject },
        (client) =>
          Effect.gen(function* () {
            const result = yield* client.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM assets",
            );
            expect(result.rows[0]?.count).toBe("1");
          }),
      ),
    );

    const client = await pool.connect();
    try {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM assets",
      );
      expect(result.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });

  it("isolates concurrent active workspaces and roles on pooled connections", async () => {
    const cases = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0
        ? {
            assetId: alphaAssetId,
            orgId: alphaOrgId,
            role: "admin",
            subject: alphaSubject,
          }
        : {
            assetId: betaAssetId,
            orgId: betaOrgId,
            role: "member",
            subject: betaSubject,
          },
    );

    const results = await Promise.all(
      cases.map((testCase) =>
        Effect.runPromise(
          withAuthenticatedTransactionEffect(
            pool,
            {
              org_id: testCase.orgId,
              org_role: testCase.role,
              sub: testCase.subject,
            },
            (client) =>
              client.query<{
                asset_id: string;
                org_id: string;
                org_role: string;
              }>(
                `SELECT asset.id::text AS asset_id,
                        public.auth_active_org_id()::text AS org_id,
                        current_setting('request.jwt.claims', true)::jsonb
                          ->> 'org_role' AS org_role
                 FROM assets AS asset
                 ORDER BY asset.id
                 LIMIT 1`,
              ),
          ),
        ).then((result) => result.rows[0]),
      ),
    );

    expect(results).toEqual(
      cases.map((testCase) => ({
        asset_id: testCase.assetId,
        org_id: testCase.orgId,
        org_role: testCase.role,
      })),
    );
  });

  it("resolves the shared workspace from the org claim", async () => {
    const sharedOrgId = "20000000-0000-4000-8000-000000000005";
    const shared = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: alphaSubject },
        (client) =>
          client.query<{
            active_user_id: string | null;
            is_shared: boolean;
            role: string | null;
            visible_memberships: string;
            visible_users: string;
          }>(
            `SELECT
             o.is_shared,
             public.auth_active_user_id()::text AS active_user_id,
             public.auth_active_org_role() AS role,
             (SELECT count(*)::text FROM users) AS visible_users,
             (SELECT count(*)::text FROM org_members) AS visible_memberships
           FROM organizations o
           WHERE o.id = public.auth_active_org_id()`,
          ),
      ),
    );

    expect(shared.rows[0]).toEqual({
      active_user_id: alphaUserId,
      is_shared: true,
      role: "admin",
      visible_memberships: "1",
      visible_users: "1",
    });
  });

  it("enforces Editor and Viewer content policies", async () => {
    const sharedOrgId = "20000000-0000-4000-8000-000000000005";
    const gammaSubject = "auth_user_local_gamma";
    const gammaUserId = "10000000-0000-4000-8000-000000000003";
    const deltaSubject = "auth_user_local_delta";
    const deltaUserId = "10000000-0000-4000-8000-000000000004";

    // Editor may write content.
    const inserted = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: gammaSubject },
        (client) =>
          client.query<{ id: string }>(
            `INSERT INTO assets (org_id, brand_profile_id, uploaded_by, asset_type, title, status)
             VALUES ($1, 'c0000000-0000-4000-8000-000000000001', $2, 'image', 'rls-editor-fixture', 'ready')
             RETURNING id::text AS id`,
            [sharedOrgId, gammaUserId],
          ),
      ),
    );
    const assetId = inserted.rows[0]!.id;
    await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: gammaSubject },
        (client) => client.query("DELETE FROM assets WHERE id = $1", [assetId]),
      ),
    );

    // Editor may not manage Brand Profiles.
    const editorBrandWrite = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: gammaSubject },
        (client) =>
          client.query(
            `INSERT INTO brand_profiles (org_id, name, color)
             VALUES ($1, 'rls-editor-forbidden', '#b91c1c')`,
            [sharedOrgId],
          ),
      ),
    );
    expect(editorBrandWrite._tag).toBe("Failure");

    // Viewer cannot write content.
    const viewerWrite = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: deltaSubject },
        (client) =>
          client.query(
            `INSERT INTO assets (org_id, brand_profile_id, uploaded_by, asset_type, title, status)
             VALUES ($1, 'c0000000-0000-4000-8000-000000000001', $2, 'image', 'rls-viewer-forbidden', 'ready')`,
            [sharedOrgId, deltaUserId],
          ),
      ),
    );
    expect(viewerWrite._tag).toBe("Failure");

    // Viewer reads remain available.
    const viewerRead = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: deltaSubject },
        (client) => client.query<{ count: string }>("SELECT count(*)::text AS count FROM assets"),
      ),
    );
    expect(Number(viewerRead.rows[0]?.count)).toBeGreaterThanOrEqual(0);
  });

  it("requires admin deletion for a Post with published distributions", async () => {
    const sharedOrgId = "20000000-0000-4000-8000-000000000005";
    const gammaSubject = "auth_user_local_gamma";
    const publishedPostId = crypto.randomUUID();
    const draftPostId = crypto.randomUUID();
    const brandProfileId = "c0000000-0000-4000-8000-000000000001";

    const asEditor = <A, E>(operation: (client: EffectTransactionClient) => Effect.Effect<A, E>) =>
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: sharedOrgId, sub: gammaSubject },
        operation,
      );

    await Effect.runPromise(
      asEditor((client) =>
        client.query(
          `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
           VALUES ($1, $2, $3, 'RLS published post', 'Published history', 'active'),
                  ($4, $2, $3, 'RLS draft post', 'Draft history', 'active')`,
          [publishedPostId, sharedOrgId, brandProfileId, draftPostId],
        ),
      ),
    );
    await Effect.runPromise(
      asEditor((client) =>
        client.query(
          `INSERT INTO distributions (
             org_id, brand_profile_id, post_id, platform, status, published_at
           )
           VALUES ($1, $2, $3, 'youtube', 'published', now())`,
          [sharedOrgId, brandProfileId, publishedPostId],
        ),
      ),
    );

    try {
      // Ordinary Editor edits to a protected Post remain allowed.
      const editorEdit = await Effect.runPromise(
        asEditor((client) =>
          client.query<{ id: string }>(
            "UPDATE posts SET title = 'RLS edited' WHERE id = $1 RETURNING id",
            [publishedPostId],
          ),
        ),
      );
      expect(editorEdit.rows).toEqual([{ id: publishedPostId }]);

      // A soft delete is an UPDATE, so the column-specific trigger must reject
      // it even though the Post row is otherwise editable.
      const editorSoftDelete = await Effect.runPromiseExit(
        asEditor((client) =>
          client.query("UPDATE posts SET deleted_at = now() WHERE id = $1", [publishedPostId]),
        ),
      );
      expect(editorSoftDelete._tag).toBe("Failure");

      // RLS hides the published Post from DELETE, so the statement affects no
      // rows instead of raising; the row and its distribution must survive.
      const editorDelete = await Effect.runPromise(
        asEditor((client) =>
          client.query<{ id: string }>("DELETE FROM posts WHERE id = $1 RETURNING id", [
            publishedPostId,
          ]),
        ),
      );
      expect(editorDelete.rows).toEqual([]);

      const survivor = await Effect.runPromise(
        asEditor((client) =>
          client.query<{ id: string }>("SELECT id FROM posts WHERE id = $1", [publishedPostId]),
        ),
      );
      expect(survivor.rows).toEqual([{ id: publishedPostId }]);

      // Drafts without published history remain deletable by Editors.
      const draftDelete = await Effect.runPromise(
        asEditor((client) =>
          client.query<{ id: string }>("DELETE FROM posts WHERE id = $1 RETURNING id", [
            draftPostId,
          ]),
        ),
      );
      expect(draftDelete.rows).toEqual([{ id: draftPostId }]);
    } finally {
      await Effect.runPromise(
        withAuthenticatedTransactionEffect(
          pool,
          { org_id: sharedOrgId, sub: alphaSubject },
          (client) => client.query("DELETE FROM posts WHERE id = $1", [publishedPostId]),
        ),
      );
    }
  });

  it("destroys connections after use when destroy-after-use is enabled", async () => {
    // Pool.query uses connect(callback) internally; it must finish and release
    // capacity before Promise-based transaction checkouts use the same pool.
    const destroyPool = destroyClientsOnRelease(
      createHyperdrivePool({ connectionString }, { max: 2 }),
    );
    try {
      const result = await destroyPool.query<{ one: number }>("SELECT 1 AS one");
      expect(result.rows).toEqual([{ one: 1 }]);
      expect(destroyPool.totalCount).toBe(0);

      const first = await destroyPool.connect();
      await first.query("SELECT 1 AS one");
      first.release();
      expect(destroyPool.totalCount).toBe(0);

      // A later checkout still works on a freshly created connection.
      const second = await destroyPool.connect();
      await second.query("SELECT 1 AS one");
      second.release();
      expect(destroyPool.totalCount).toBe(0);
    } finally {
      await destroyPool.end();
    }
  });
});

describe("Effect transaction paths against PostgreSQL", () => {
  it("commits withTransactionEffect and returns typed rows", async () => {
    const result = await Effect.runPromise(
      withTransactionEffect(pool, (client) => client.query<{ one: number }>("SELECT 1 AS one")),
    );
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it("maps query failures to DatabaseError and releases the connection", async () => {
    const exit = await Effect.runPromiseExit(
      withTransactionEffect(pool, (client) => client.query("SELECT * FROM no_such_relation")),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "DatabaseError" });
      }
    }

    const probe = await Effect.runPromise(
      withTransactionEffect(pool, (client) => client.query<{ one: number }>("SELECT 1 AS one")),
    );
    expect(probe.rows).toEqual([{ one: 1 }]);
  });

  it("destroys the pooled connection when rollback fails", async () => {
    const raw = await pool.connect();
    let destroyed = false;
    const rollbackFailing = {
      query: (text: string, values?: readonly unknown[]) =>
        text === "ROLLBACK"
          ? Promise.reject(new Error("rollback failed"))
          : raw.query(text, values === undefined ? undefined : [...values]),
      release: (destroy?: boolean) => {
        destroyed = destroy ?? false;
        raw.release(destroy);
      },
    };
    await expect(
      Effect.runPromise(
        withTransactionEffect({ connect: async () => rollbackFailing }, () =>
          Effect.fail(new Error("boom")),
        ),
      ),
    ).rejects.toThrow("boom");
    expect(destroyed).toBe(true);
  });

  it("destroys the pooled connection when commit fails", async () => {
    const raw = await pool.connect();
    let destroyed = false;
    const commitFailing = {
      query: (text: string, values?: readonly unknown[]) =>
        text === "COMMIT"
          ? Promise.reject(new Error("commit failed"))
          : raw.query(text, values === undefined ? undefined : [...values]),
      release: (destroy?: boolean) => {
        destroyed = destroy ?? false;
        raw.release(destroy);
      },
    };
    const exit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => commitFailing }, (client) =>
        client.query("SELECT 1 AS one"),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          _tag: "DatabaseError",
          message: expect.stringContaining("commit failed"),
        });
      }
    }
    expect(destroyed).toBe(true);
  });

  it("enforces tenant isolation through withAuthenticatedTransactionEffect", async () => {
    const alpha = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        pool,
        { org_id: alphaOrgId, sub: alphaSubject },
        (client) =>
          client.query<{ id: string; org_id: string }>("SELECT id, org_id FROM assets ORDER BY id"),
      ),
    );
    expect(alpha.rows).toEqual([{ id: alphaAssetId, org_id: alphaOrgId }]);
  });

  it("rejects blank subject claims as InvalidRequestError", async () => {
    const exit = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, { org_id: alphaOrgId, sub: "   " }, (client) =>
        client.query("SELECT 1 AS one"),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "InvalidRequestError" });
      }
    }
  });

  it("serves scoped clients and the live DatabaseService", async () => {
    const scoped = await Effect.runPromise(
      Effect.scoped(
        acquireClient(pool).pipe(
          Effect.flatMap((client) => client.query<{ two: number }>("SELECT 2 AS two")),
        ),
      ),
    );
    expect(scoped.rows).toEqual([{ two: 2 }]);

    const layer = createDatabaseServiceLive(pool);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* DatabaseService;
        const one = yield* database.withTransaction((client) =>
          client.query<{ one: number }>("SELECT 1 AS one"),
        );
        const alpha = yield* database.withAuthenticatedTransaction(
          { org_id: alphaOrgId, sub: alphaSubject },
          (client) => client.query<{ id: string }>("SELECT id FROM assets ORDER BY id"),
        );
        return { alpha, one };
      }).pipe(Effect.provide(layer)),
    );
    expect(result.one.rows).toEqual([{ one: 1 }]);
    expect(result.alpha.rows).toEqual([{ id: alphaAssetId }]);
  });
});

// Brand Profile ownership boundary (issue #255): brand_profiles is the
// mandatory parent of assets, platform_accounts, and distributions. These
// tests exercise the real constraints through authenticated transactions so
// both DDL enforcement and RLS visibility are covered. Seeded users are
// workspace admins; a member-role fixture cannot be created because
// org_members grants no INSERT to the authenticated role.
describe("Brand Profile ownership and lifecycle constraints", () => {
  const seededAlphaProfile = "a0000000-0000-4000-8000-000000000001";
  const seededBetaProfile = "a0000000-0000-4000-8000-000000000002";
  const profileA = "b0000000-0000-4000-8000-0000000000a1";
  const profileB = "b0000000-0000-4000-8000-0000000000b1";
  const betaProfile = "b0000000-0000-4000-8000-0000000000c1";
  const assetA = "40000000-0000-4000-8000-0000000000a1";
  const assetB = "40000000-0000-4000-8000-0000000000b1";
  const accountA = "50000000-0000-4000-8000-0000000000a1";
  const accountB = "50000000-0000-4000-8000-0000000000b1";

  const postA = "48000000-0000-4000-8000-0000000000a1";
  const postB = "48000000-0000-4000-8000-0000000000b1";
  const alphaClaims = { org_id: alphaOrgId, sub: alphaSubject };
  const betaClaims = { org_id: betaOrgId, sub: betaSubject };

  // Platform accounts are written through the system role in production
  // (meltiply_rls holds no INSERT grant on the table), so fixtures for them
  // use a privileged pool; brand profile, asset, and distribution writes stay
  // on the authenticated pool to exercise RLS.
  const systemPool = createHyperdrivePool(
    {
      connectionString:
        process.env.MELTIPLY_DATABASE_SYSTEM_TEST_URL ??
        "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
    },
    { max: 1 },
  );
  const asSystem = <A, E>(operation: (client: EffectTransactionClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(withTransactionEffect(systemPool, operation));
  const asAlpha = <A, E>(operation: (client: EffectTransactionClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(withAuthenticatedTransactionEffect(pool, alphaClaims, operation));

  // Inserts the two alpha profiles used across the suite; callers that need
  // additional rows create them inside their own transaction.
  const seedProfiles = () =>
    asAlpha((client) =>
      client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Suite Alpha', '#1d4ed8'),
                ($3, $2, 'Suite Beta', '#15803d')
         ON CONFLICT (id) DO NOTHING`,
        [profileA, alphaOrgId, profileB],
      ),
    );

  afterEach(async () => {
    // Deleting the profiles cascades through every owned row, so cleanup
    // needs no per-table deletes; referential actions bypass RLS.
    await asAlpha((client) =>
      client.query("DELETE FROM brand_profiles WHERE id = ANY($1::uuid[])", [[profileA, profileB]]),
    );
    await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, betaClaims, (client) =>
        client.query("DELETE FROM brand_profiles WHERE id = $1", [betaProfile]),
      ),
    );
  });

  it("enforces normalized unique names per workspace and reserves soft-deleted names", async () => {
    await seedProfiles();

    // Case and whitespace variants collide with the stored normalized name.
    const duplicate = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (org_id, name, color)
           VALUES ($1, '  suite   ALPHA ', '#15803d')`,
          [alphaOrgId],
        ),
      ),
    );
    expect(duplicate._tag).toBe("Failure");

    // The same normalized name is free in another workspace.
    await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, betaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (id, org_id, name, color)
           VALUES ($1, $2, 'Suite Alpha', '#1d4ed8')`,
          [betaProfile, betaOrgId],
        ),
      ),
    );

    // Soft deletion keeps the name reserved until purge.
    await asAlpha((client) =>
      client.query(
        `UPDATE brand_profiles
         SET deleted_at = now(), purge_at = now() + interval '7 days'
         WHERE id = $1`,
        [profileB],
      ),
    );
    const reserved = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (org_id, name, color)
           VALUES ($1, 'Suite Beta', '#15803d')`,
          [alphaOrgId],
        ),
      ),
    );
    expect(reserved._tag).toBe("Failure");
  });

  it("restricts color to the fixed palette and pairs deleted_at with purge_at", async () => {
    const badColor = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (org_id, name, color)
           VALUES ($1, 'Off Palette', '#123456')`,
          [alphaOrgId],
        ),
      ),
    );
    expect(badColor._tag).toBe("Failure");

    const unpairedPurge = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (org_id, name, color, deleted_at)
           VALUES ($1, 'No Purge', '#15803d', now())`,
          [alphaOrgId],
        ),
      ),
    );
    expect(unpairedPurge._tag).toBe("Failure");
  });

  it("requires brand_profile_id on owned tables and rejects cross-brand references", async () => {
    await seedProfiles();
    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets (id, org_id, brand_profile_id, title)
         VALUES ($1, $2, $3, 'A'), ($4, $2, $5, 'B')`,
        [assetA, alphaOrgId, profileA, assetB, profileB],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text)
         VALUES ($1, $2, $3, 'A', 'alpha post'),
                ($4, $2, $5, 'B', 'beta post')`,
        [postA, alphaOrgId, profileA, postB, profileB],
      ),
    );
    await asSystem((client) =>
      client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES ($1, $2, $3, 'youtube', 'suite-yt-a', 'tok'),
                ($4, $2, $5, 'tiktok', 'suite-tt-b', 'tok')`,
        [accountA, alphaOrgId, profileA, accountB, profileB],
      ),
    );

    // Missing brand_profile_id violates NOT NULL.
    const unowned = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(`INSERT INTO assets (org_id, title) VALUES ($1, 'orphan')`, [alphaOrgId]),
      ),
    );
    expect(unowned._tag).toBe("Failure");

    // A Post cannot be attached to an Asset owned by another Brand Profile.
    const crossAttachment = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
           VALUES ($1, $2, $3, $4, 0)`,
          [postA, assetB, alphaOrgId, profileA],
        ),
      ),
    );
    expect(crossAttachment._tag).toBe("Failure");

    // Same-brand distribution succeeds.
    await asAlpha((client) =>
      client.query(
        `INSERT INTO distributions
           (org_id, brand_profile_id, post_id, platform_account_id, platform)
         VALUES ($1, $2, $3, $4, 'youtube')`,
        [alphaOrgId, profileA, postA, accountA],
      ),
    );

    // Post from another brand profile is rejected by the composite FK.
    const crossPost = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO distributions
             (org_id, brand_profile_id, post_id, platform_account_id, platform)
           VALUES ($1, $2, $3, $4, 'tiktok')`,
          [alphaOrgId, profileA, postB, accountA],
        ),
      ),
    );
    expect(crossPost._tag).toBe("Failure");

    // Platform account from another brand profile is rejected likewise.
    const crossAccount = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO distributions
             (org_id, brand_profile_id, post_id, platform_account_id, platform)
           VALUES ($1, $2, $3, $4, 'tiktok')`,
          [alphaOrgId, profileA, postA, accountB],
        ),
      ),
    );
    expect(crossAccount._tag).toBe("Failure");

    // One Post and Channel pair has at most one Distribution row.
    const duplicateDistribution = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO distributions
             (org_id, brand_profile_id, post_id, platform_account_id, platform)
           VALUES ($1, $2, $3, $4, 'youtube')`,
          [alphaOrgId, profileA, postA, accountA],
        ),
      ),
    );
    expect(duplicateDistribution._tag).toBe("Failure");
  });

  it("enforces globally unique external account identity", async () => {
    await seedProfiles();
    await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, betaClaims, (client) =>
        client.query(
          `INSERT INTO brand_profiles (id, org_id, name, color)
           VALUES ($1, $2, 'Beta Suite', '#1d4ed8')`,
          [betaProfile, betaOrgId],
        ),
      ),
    );
    await asSystem((client) =>
      client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES ($1, $2, $3, 'youtube', 'suite-global-yt', 'tok')`,
        [accountA, alphaOrgId, profileA],
      ),
    );

    // The same external identity cannot attach to another workspace; the
    // duplicate attempt also runs as the system role because the
    // authenticated role holds no INSERT grant on platform_accounts.
    const duplicate = await Effect.runPromiseExit(
      withTransactionEffect(systemPool, (client) =>
        client.query(
          `INSERT INTO platform_accounts
             (org_id, brand_profile_id, platform, platform_user_id, access_token)
           VALUES ($1, $2, 'youtube', 'suite-global-yt', 'tok')`,
          [betaOrgId, betaProfile],
        ),
      ),
    );
    expect(duplicate._tag).toBe("Failure");
  });

  it("scopes profile visibility by role and lifecycle state", async () => {
    await seedProfiles();
    await asAlpha((client) =>
      client.query(
        `UPDATE brand_profiles
         SET deleted_at = now(), purge_at = now() + interval '7 days'
         WHERE id = $1`,
        [profileB],
      ),
    );

    // Admins see active and soft-deleted profiles in their workspace.
    const adminRows = await asAlpha((client) =>
      client.query<{ id: string }>("SELECT id FROM brand_profiles ORDER BY name"),
    );
    expect(adminRows.rows.map((row) => row.id).sort()).toEqual(
      [seededAlphaProfile, profileA, profileB].sort(),
    );
    // Beta sees only its seed profile, never Alpha's active or deleted rows.
    const betaRows = await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, betaClaims, (client) =>
        client.query<{ id: string }>("SELECT id FROM brand_profiles"),
      ),
    );
    expect(betaRows.rows).toEqual([{ id: seededBetaProfile }]);
  });

  it("purges owned rows when a brand profile is deleted", async () => {
    await seedProfiles();
    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets (id, org_id, brand_profile_id, title)
         VALUES ($1, $2, $3, 'A')`,
        [assetA, alphaOrgId, profileA],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text)
         VALUES ($1, $2, $3, 'A', 'purge')`,
        [postA, alphaOrgId, profileA],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
         VALUES ($1, $2, $3, $4, 0)`,
        [postA, assetA, alphaOrgId, profileA],
      ),
    );
    await asSystem((client) =>
      client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES ($1, $2, $3, 'youtube', 'suite-purge-yt', 'tok')`,
        [accountA, alphaOrgId, profileA],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `INSERT INTO distributions
           (org_id, brand_profile_id, post_id, platform_account_id, platform)
         VALUES ($1, $2, $3, $4, 'youtube')`,
        [alphaOrgId, profileA, postA, accountA],
      ),
    );

    await asAlpha((client) => client.query("DELETE FROM brand_profiles WHERE id = $1", [profileA]));

    const remaining = await asAlpha((client) =>
      client.query<{
        assets: string;
        accounts: string;
        attachments: string;
        distributions: string;
        posts: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM assets WHERE brand_profile_id = $1) AS assets,
           (SELECT count(*)::text FROM platform_accounts WHERE brand_profile_id = $1) AS accounts,
           (SELECT count(*)::text FROM post_attachments WHERE brand_profile_id = $1) AS attachments,
           (SELECT count(*)::text FROM distributions WHERE brand_profile_id = $1) AS distributions,
           (SELECT count(*)::text FROM posts WHERE brand_profile_id = $1) AS posts`,
        [profileA],
      ),
    );
    expect(remaining.rows[0]).toEqual({
      assets: "0",
      accounts: "0",
      attachments: "0",
      distributions: "0",
      posts: "0",
    });
  });

  // asset_objects is the only source of truth for R2 keys, so the member role
  // must be able to write the staging inventory the upload lifecycle settles
  // while every protected original, thumbnail, and rendition row stays
  // read-only. The assertions run against the live PostgreSQL rules rather
  // than inspecting the policy text, so they catch a dropped column grant or
  // an over-broad check even if the policy is later rewritten.
  it("lets members write their own staging objects but not protected inventory", async () => {
    await seedProfiles();
    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets (id, org_id, brand_profile_id, title)
         VALUES ($1, $2, $3, 'A')`,
        [assetA, alphaOrgId, profileA],
      ),
    );
    const stagingKey = `staging/${alphaOrgId}/${assetA}/90000000-0000-4000-8000-000000000099/staged.png`;

    // A member can create its own staging inventory row.
    const inserted = await asAlpha((client) =>
      client.query<{ id: string }>(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, content_type, status)
         VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing')
         RETURNING id`,
        [alphaOrgId, assetA, profileA, stagingKey],
      ),
    );
    const stagingObjectId = inserted.rows[0]!.id;
    expect(stagingObjectId).toMatch(/^[0-9a-f-]{36}$/);

    // A member can settle verified bytes, record the writer deadline, and hand
    // the quota reservation onto the staging row.
    const settled = await asAlpha((client) =>
      client.query<{ status: string }>(
        `UPDATE asset_objects
         SET bytes = $2, etag = 'etag', version = 'v1', sha256 = 'sha',
             content_type = 'image/png', status = 'ready', updated_at = now()
         WHERE id = $1 AND kind = 'staging'
         RETURNING status`,
        [stagingObjectId, 4096],
      ),
    );
    expect(settled.rows[0]!.status).toBe("ready");
    await asAlpha((client) =>
      client.query(
        `UPDATE asset_objects
         SET write_hold_until = now() + interval '1 hour',
             reserved_bytes = $2, updated_at = now()
         WHERE id = $1 AND kind = 'staging'`,
        [stagingObjectId, 2048],
      ),
    );

    // A member can move its own staging row into deletion for the sweep.
    const deleting = await asAlpha((client) =>
      client.query<{ status: string }>(
        `UPDATE asset_objects
         SET status = 'deleting', updated_at = now()
         WHERE id = $1 AND kind = 'staging'
         RETURNING status`,
        [stagingObjectId],
      ),
    );
    expect(deleting.rows[0]!.status).toBe("deleting");

    // Protected inventory in another workspace is invisible to foreign
    // members, and protected kinds in the same workspace reject the write.
    const foreign = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, betaClaims, (client) =>
        client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, content_type, status)
           VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing')`,
          [betaOrgId, assetA, seededBetaProfile, `staging/${betaOrgId}/${assetA}/foreign.png`],
        ),
      ),
    );
    expect(foreign._tag).toBe("Failure");

    const crossKindInsert = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes, content_type, status)
           VALUES ($1, $2, $3, 'original', 'x/y/protected.png', 10, 'image/png', 'ready')`,
          [alphaOrgId, assetA, profileA],
        ),
      ),
    );
    expect(crossKindInsert._tag).toBe("Failure");

    // A protected row for this same Asset is installed by the system role, so
    // the member's attempt to move its bytes targets a row that really exists:
    // an UPDATE matching nothing would prove nothing.
    const protectedObject = await asSystem((client) =>
      client.query<{ id: string }>(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, status)
         VALUES ($1, $2, $3, 'original', $4, 4096, 'image/png', 'ready')
         RETURNING id`,
        [alphaOrgId, assetA, profileA, `${alphaOrgId}/${assetA}/original`],
      ),
    );
    const protectedUpdate = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(`UPDATE asset_objects SET bytes = 1 WHERE id = $1`, [
          protectedObject.rows[0]!.id,
        ]),
      ),
    );
    expect(protectedUpdate._tag).toBe("Failure");

    // Identity, ownership, and media columns are not writable by members.
    const keySwap = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(`UPDATE asset_objects SET r2_key = 'staging/evil.png' WHERE id = $1`, [
          stagingObjectId,
        ]),
      ),
    );
    expect(keySwap._tag).toBe("Failure");

    // Terminal and superseded states stay system-owned.
    const terminal = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(`UPDATE asset_objects SET status = 'deleted' WHERE id = $1`, [
          stagingObjectId,
        ]),
      ),
    );
    expect(terminal._tag).toBe("Failure");
  });

  // A saved draft must never lose its media. These assertions pin the two
  // corrections in migration 006: a finalized upload that is still being
  // processed may carry the orphan clock that the API arms at completion (the
  // first upload a creator saves used to be rejected outright), and detaching
  // the last attachment from a draft whose processing failed re-arms the
  // seven-day window instead of leaving a reclaimed candidate with no
  // deadline. They run through the real triggers rather than asserting on the
  // constraint or function text.
  it("arms and preserves orphan clocks across processing and failed detaches", async () => {
    await seedProfiles();
    const processingAsset = "40000000-0000-4000-8000-0000000000d1";
    const failedAsset = "40000000-0000-4000-8000-0000000000d2";
    const unfinishedAsset = "40000000-0000-4000-8000-0000000000d3";
    const draftPost = "48000000-0000-4000-8000-0000000000d1";

    // Upload sessions reference pre-existing Assets, just as the real upload
    // creation transaction does; completion then changes their lifecycle state.
    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, asset_type, title, status)
         SELECT unnest($1::uuid[]), $2, $3, 'image', 'Upload intent', 'uploading'`,
        [[processingAsset, failedAsset], alphaOrgId, profileA],
      ),
    );

    // An upload session is the evidence that an Asset is finalized.
    await asSystem((client) =>
      client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, strategy, status, content_type, file_size, object_key, expires_at, completed_at)
         VALUES ($1, $2, $3, 'single', 'completed', 'image/png', 4096, $4, now(), now())`,
        [
          "91000000-0000-4000-8000-0000000000d1",
          alphaOrgId,
          processingAsset,
          `staging/${alphaOrgId}/${processingAsset}/91000000-0000-4000-8000-0000000000d1/f.png`,
        ],
      ),
    );
    await asSystem((client) =>
      client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, strategy, status, content_type, file_size, object_key, expires_at, completed_at)
         VALUES ($1, $2, $3, 'single', 'completed', 'image/png', 4096, $4, now(), now())`,
        [
          "91000000-0000-4000-8000-0000000000d2",
          alphaOrgId,
          failedAsset,
          `staging/${alphaOrgId}/${failedAsset}/91000000-0000-4000-8000-0000000000d2/f.png`,
        ],
      ),
    );

    // The API completion path: verified upload, status 'processing', orphan
    // clock armed for an asset that is not attached to anything yet.
    const completed = await asAlpha((client) =>
      client.query<{
        orphaned_at: Date | null;
        orphan_delete_after: Date | null;
      }>(
        `UPDATE assets
         SET status = 'processing', finalized_at = now(),
             orphaned_at = now(), orphan_delete_after = now() + interval '7 days',
             updated_at = now()
         WHERE id = $1
         RETURNING orphaned_at, orphan_delete_after`,
        [processingAsset],
      ),
    ).then((result) => result.rows[0]);
    expect(completed).toMatchObject({
      orphaned_at: expect.any(Date),
      orphan_delete_after: expect.any(Date),
    });

    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets (id, org_id, brand_profile_id, title, status, finalized_at)
         VALUES ($1, $2, $3, 'Uploading', 'uploading', NULL)`,
        [unfinishedAsset, alphaOrgId, profileA],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `UPDATE assets
         SET title = 'Failed', status = 'failed', finalized_at = now(),
             failure_code = 'processing_failed', failure_message = 'Decode failed.',
             failure_retryable = true, failure_at = now()
         WHERE id = $1`,
        [failedAsset],
      ),
    );
    await asAlpha((client) =>
      client.query(
        `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text)
         VALUES ($1, $2, $3, 'Draft', 'draft text')`,
        [draftPost, alphaOrgId, profileA],
      ),
    );

    // Saving the draft keeps both attachments, including the failed one.
    await asAlpha((client) =>
      client.query(
        `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
         VALUES ($1, $2, $3, $4, 0), ($1, $5, $3, $4, 1)`,
        [draftPost, processingAsset, alphaOrgId, profileA, failedAsset],
      ),
    );

    // A retained reference cancels the orphan deadline on attach.
    const afterAttach = await asAlpha((client) =>
      client.query<{
        orphaned_at: string | null;
        orphan_delete_after: string | null;
      }>(`SELECT orphaned_at, orphan_delete_after FROM assets WHERE id = $1`, [processingAsset]),
    ).then((result) => result.rows[0]);
    expect(afterAttach?.orphaned_at).toBeNull();
    expect(afterAttach?.orphan_delete_after).toBeNull();

    // Detaching the last attachment from the FAILED asset arms a fresh
    // seven-day window: the creator removed an attachment, and the bytes are
    // still reclaimable only after the grace period.
    await asAlpha((client) =>
      client.query(`DELETE FROM post_attachments WHERE post_id = $1 AND asset_id = $2`, [
        draftPost,
        failedAsset,
      ]),
    );
    const failedAfterDetach = await asAlpha((client) =>
      client.query<{
        orphaned_at: string | null;
        orphan_delete_after: string | null;
      }>(`SELECT orphaned_at, orphan_delete_after FROM assets WHERE id = $1`, [failedAsset]),
    ).then((result) => result.rows[0]);
    expect(failedAfterDetach?.orphaned_at).not.toBeNull();
    expect(failedAfterDetach?.orphan_delete_after).not.toBeNull();
    expect(
      new Date(failedAfterDetach!.orphan_delete_after!).getTime() -
        new Date(failedAfterDetach!.orphaned_at!).getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1000);

    // An upload that never finalized still cannot carry a clock.
    const unfinishedClock = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `UPDATE assets SET orphaned_at = now(), orphan_delete_after = now() + interval '7 days' WHERE id = $1`,
          [unfinishedAsset],
        ),
      ),
    );
    expect(unfinishedClock._tag).toBe("Failure");

    // A claimed Asset has already cleared its orphan clock and cannot acquire
    // a new retained reference. Use the vacated position so an unrelated unique
    // position constraint cannot make this guard test pass.
    await asAlpha((client) =>
      client.query(
        `INSERT INTO assets (id, org_id, brand_profile_id, title, status, finalized_at)
         VALUES ($1, $2, $3, 'Deleting', 'deleting', now())`,
        ["40000000-0000-4000-8000-0000000000d4", alphaOrgId, profileA],
      ),
    );
    const attachToDeleting = await Effect.runPromiseExit(
      withAuthenticatedTransactionEffect(pool, alphaClaims, (client) =>
        client.query(
          `INSERT INTO post_attachments (post_id, asset_id, org_id, brand_profile_id, position)
           VALUES ($1, $2, $3, $4, 1)`,
          [draftPost, "40000000-0000-4000-8000-0000000000d4", alphaOrgId, profileA],
        ),
      ),
    );
    expect(attachToDeleting._tag).toBe("Failure");
  });
});

describe("database boundary validation", () => {
  it("rejects blank Hyperdrive connection strings and blank subjects", () => {
    expect(() => createHyperdrivePool({ connectionString: "   " })).toThrow(TypeError);
    expect(() => serializeAuthenticatedClaims({ org_id: alphaOrgId, sub: "  " })).toThrow(
      TypeError,
    );
  });

  it("keeps the test-layer double aligned with the live service shape", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* DatabaseService;
        return yield* database.withTransaction(() => Effect.succeed("ok"));
      }).pipe(Effect.provide(createDatabaseServiceTest())),
    );
    expect(result).toBe("ok");
  });
});
