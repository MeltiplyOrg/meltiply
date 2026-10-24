import type { JwtIdentity } from "@meltiply/auth";
import {
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderPublicationRequirements,
} from "@meltiply/providers";
import { Effect } from "effect";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import {
  withSystemTransactionEffect,
  type EffectTransactionClient,
} from "../src/database";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: "https://api.meltiply.local",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

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

const brandProfileId = "a0000000-0000-4000-8000-0000000000e1";
const accountId = "94000000-0000-4000-8000-000000000292";
const platformUserId = "integration-requirements-runtime-creator";

const defaultRequirements: ProviderPublicationRequirements = {
  commentAllowed: true,
  creatorAvatarUrl: "https://example.com/avatar.png",
  creatorDisplayName: "Integration Runtime Creator",
  creatorUsername: "integration.runtime",
  duetAllowed: false,
  maxVideoDurationSeconds: 180,
  platform: "tiktok",
  privacyLevels: ["PUBLIC_TO_EVERYONE"],
  stitchAllowed: true,
};

/** Builds a fully resolved actor with the given seeded claims. */
function actorFor(claims: typeof alpha): ResolvedActor {
  return {
    authUserId: claims.subject,
    claims,
    displayName: "Integration Actor",
    email: `${claims.subject}@meltiply.local`,
    isInstallationOwner: false,
    role: "admin",
    userId: claims.userId,
    workspace: {
      id: claims.organizationId,
      name: "Integration Workspace",
      slug: "integration-workspace",
    },
  };
}

/** Runs one system-pool transaction at the integration-test boundary. */
function systemTransaction<A>(
  operation: (client: EffectTransactionClient) => Effect.Effect<A>,
): Promise<A> {
  return Effect.runPromise(withSystemTransactionEffect(env, operation));
}

type RequirementRead = NonNullable<ProviderAdapter["getPublicationRequirements"]>;

/** Builds one publish-capable TikTok adapter whose requirement read the scenario controls. */
function requirementAdapter(read: RequirementRead): ProviderAdapter {
  return {
    capability: {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: [],
      notes: [],
      platform: "tiktok",
      publish: false,
      reply: false,
    },
    getPublicationRequirements: read,
    transferModes: [],
  };
}

/** Creates one controlled Provider registry for a scenario's adapters. */
function registryFor(read: RequirementRead) {
  const registry = new ProviderRegistry();
  registry.register("tiktok", requirementAdapter(read));
  return registry;
}

/**
 * Creates the production app with the controlled Provider registry and one actor.
 *
 * Injecting the verified identity and resolved actor keeps authentication
 * deterministic while the route still performs the real tenant-scoped RLS read
 * and credential decryption. Two identities in one scenario share the registry,
 * matching the production app's single registry, so identity isolation is
 * exercised inside one configuration namespace.
 */
function appFor(actor: ResolvedActor, registry: ProviderRegistry) {
  const identity: JwtIdentity = {
    email: actor.email,
    name: actor.displayName,
    subject: actor.subject,
  };
  return createApiApp({
    providerRegistry: registry,
    resolveActor: async () => actor,
    verifyJwtToken: async () => identity,
  });
}

/** Issues one authenticated publishing-requirements read with explicit correlation. */
function requirementsRequest(app: Hono<ApiWorkerEnvironment>, requestId: string) {
  return app.request(
    `/api/v1/platforms/${accountId}/publishing-requirements`,
    {
      headers: {
        Authorization: "Bearer integration-test",
        "X-Request-ID": requestId,
      },
    },
    env,
  );
}

/** Test-controlled Provider read settlement used to hold coalescing pending. */
interface RequirementGate {
  readonly promise: Promise<ProviderPublicationRequirements>;
  reject(cause: unknown): void;
  resolve(value: ProviderPublicationRequirements): void;
}

let baseAccessToken: string;

describe("publishing-requirement coalescing with PostgreSQL RLS", () => {
  beforeAll(async () => {
    baseAccessToken = await tokenCipherFor(env).encrypt("integration-runtime-access");
    await systemTransaction((client) =>
      Effect.gen(function* () {
        yield* client.query("DELETE FROM brand_profiles WHERE id = $1", [brandProfileId]);
        yield* client.query("DELETE FROM platform_accounts WHERE platform_user_id = $1", [
          platformUserId,
        ]);
        yield* client.query(
          `INSERT INTO brand_profiles (id, org_id, name, color)
           VALUES ($1, $2, 'Integration Requirements Brand', '#1d4ed8')`,
          [brandProfileId, alpha.organizationId],
        );
        yield* client.query(
          `INSERT INTO platform_accounts
             (id, org_id, brand_profile_id, platform, platform_user_id,
              access_token, scopes, connection_status, token_expires_at, updated_at)
           VALUES ($1, $2, $3, 'tiktok', $4, $5,
                   ARRAY['user.info.basic', 'video.publish'], 'connected',
                   '2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
          [accountId, alpha.organizationId, brandProfileId, platformUserId, baseAccessToken],
        );
      }),
    );
  });

  beforeEach(async () => {
    await systemTransaction((client) =>
      client.query(
        `UPDATE platform_accounts
         SET access_token = $2,
             connection_status = 'connected',
             revoked_at = NULL,
             token_expires_at = '2026-08-01T00:00:00Z',
             updated_at = '2026-07-01T00:00:00Z'
         WHERE id = $1`,
        [accountId, baseAccessToken],
      ),
    );
  });

  afterAll(async () => {
    await systemTransaction((client) =>
      client.query("DELETE FROM brand_profiles WHERE id = $1", [brandProfileId]),
    );
  });

  it("performs a fresh authenticated Provider read after each settlement", async () => {
    let attempt = 0;
    const read = vi.fn(async () => {
      attempt += 1;
      return { ...defaultRequirements, creatorDisplayName: `Read ${attempt}` };
    });
    const app = appFor(actorFor(alpha), registryFor(read));

    const first = await requirementsRequest(app, "integration-requirements-first");
    const second = await requirementsRequest(app, "integration-requirements-second");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("X-Request-ID")).toBe("integration-requirements-first");
    expect(second.headers.get("X-Request-ID")).toBe("integration-requirements-second");
    expect(await first.json()).toMatchObject({ creator: { display_name: "Read 1" } });
    expect(await second.json()).toMatchObject({ creator: { display_name: "Read 2" } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects another Workspace while an equivalent read is pending", async () => {
    const started = Promise.withResolvers<void>();
    const gate: RequirementGate = Promise.withResolvers<ProviderPublicationRequirements>();
    const read = vi.fn(() => {
      started.resolve();
      return gate.promise;
    });
    const registry = registryFor(read);
    const alphaApp = appFor(actorFor(alpha), registry);
    const betaApp = appFor(actorFor(beta), registry);

    const pending = requirementsRequest(alphaApp, "integration-requirements-alpha");
    await started.promise;
    const denied = await requirementsRequest(betaApp, "integration-requirements-beta");
    gate.resolve(defaultRequirements);

    expect(denied.status).toBe(404);
    expect(read).toHaveBeenCalledOnce();
    expect((await pending).status).toBe(200);
  });

  it("rejects a revoked account while an equivalent read is pending", async () => {
    const started = Promise.withResolvers<void>();
    const gate: RequirementGate = Promise.withResolvers<ProviderPublicationRequirements>();
    const read = vi.fn(() => {
      started.resolve();
      return gate.promise;
    });
    const app = appFor(actorFor(alpha), registryFor(read));

    const pending = requirementsRequest(app, "integration-requirements-valid");
    await started.promise;
    await systemTransaction((client) =>
      client.query(
        `UPDATE platform_accounts
         SET connection_status = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1`,
        [accountId],
      ),
    );
    const revoked = await requirementsRequest(app, "integration-requirements-revoked");
    gate.resolve(defaultRequirements);

    expect(revoked.status).toBe(409);
    expect(read).toHaveBeenCalledOnce();
    expect((await pending).status).toBe(200);
  });

  it("starts a separate read for a rotated credential generation", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstGate: RequirementGate = Promise.withResolvers<ProviderPublicationRequirements>();
    const secondGate: RequirementGate = Promise.withResolvers<ProviderPublicationRequirements>();
    let attempts = 0;
    const read = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        firstStarted.resolve();
        return firstGate.promise;
      }
      secondStarted.resolve();
      return secondGate.promise;
    });
    const app = appFor(actorFor(alpha), registryFor(read));

    const before = requirementsRequest(app, "integration-requirements-before");
    await firstStarted.promise;
    const rotated = await tokenCipherFor(env).encrypt("integration-runtime-rotated-again");
    await systemTransaction((client) =>
      client.query(
        `UPDATE platform_accounts
         SET access_token = $2, updated_at = '2026-07-02T00:00:00Z'
         WHERE id = $1`,
        [accountId, rotated],
      ),
    );
    const after = requirementsRequest(app, "integration-requirements-after");
    await secondStarted.promise;
    firstGate.resolve({ ...defaultRequirements, creatorDisplayName: "Before rotation" });
    secondGate.resolve({ ...defaultRequirements, creatorDisplayName: "After rotation" });

    expect(read).toHaveBeenCalledTimes(2);
    const [beforeResponse, afterResponse] = await Promise.all([before, after]);
    expect(beforeResponse.status).toBe(200);
    expect(afterResponse.status).toBe(200);
    expect(await beforeResponse.json()).toMatchObject({
      creator: { display_name: "Before rotation" },
    });
    expect(await afterResponse.json()).toMatchObject({
      creator: { display_name: "After rotation" },
    });
  });
});
