/**
 * Controlled-Provider acceptance entry for the API Worker.
 *
 * The HTTP surface is the production one: `createApiApp` is instantiated
 * unmodified and every `/api/v1/**`, `/api/auth/**`, `/operator/v1/**`, flow,
 * and health route behaves exactly as it does in `src/index.ts`. The single
 * difference is the {@link ProviderRegistry} supplied through
 * `createApiApp({ providerRegistry })`, the dependency slot the route module
 * already exposes, so the acceptance run sees real publishing capabilities and
 * the real OAuth boundary instead of the "provider adapter is not configured"
 * stubs a credential-less local stack would otherwise advertise.
 *
 * This module additionally mounts `/controlled-provider/v1/**`, a fixture-only
 * namespace used by the Playwright acceptance specs to (a) provision the
 * Channels a signed-up workspace needs, because the OAuth connect boundary
 * requires an HTTPS provider origin that a plain-HTTP local stack cannot
 * provide, and (b) read back the controlled Provider's own durable publication
 * records and stored media bytes. Those endpoints exist only inside this
 * acceptance entry: no production route, service, or interface was added, and
 * the production `wrangler.local.jsonc` still points at `src/index.ts`.
 */

import {
  createControlledProviderRegistry,
  controlledProviderPlatforms,
  readControlledPublications,
  readControlledScript,
  type ControlledProviderBucket,
  writeControlledScript,
} from "../../automation/test-support/controlled-provider";
import { createApiApp } from "../src/app";
import { withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";
import { Effect } from "effect";
import { Hono } from "hono";

/** One Channel an acceptance spec asks the fixture to provision. */
interface ChannelRequest {
  display_name: string;
  platform: string;
  provider_user_id: string;
}

/** Body accepted by the channel provisioning endpoint. */
interface ProvisionChannelsRequest {
  channels: ChannelRequest[];
  profile_name: string;
}

/** Body accepted by the provider script endpoint. */
interface ScriptRequest {
  account_id: string;
  fail_next_publishes?: number;
}

/**
 * Parses a positive integer from an untrusted query or body value.
 *
 * @param value - Untrusted value to parse.
 * @param field - Field name used in the thrown message.
 * @returns The parsed non-negative integer.
 * @throws {TypeError} When the value is missing, negative, or not an integer.
 */
function requireCount(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Path prefix owned solely by this acceptance entry.
 *
 * Kept disjoint from every production namespace so the fixture router can
 * never shadow a real route, and asserted by the acceptance specs themselves:
 * a production deployment answers this prefix with the ordinary not-found
 * envelope.
 */
const controlledProviderRoutePrefix = "/controlled-provider/v1";
/**
 * Fixture-only router exposing the controlled Provider's own state and the
 * Channel provisioning local acceptance needs.
 *
 * Deliberately unauthenticated: it is unreachable outside
 * `wrangler.local.acceptance.jsonc`, and it never reads or writes application
 * data beyond the `platform_accounts` rows it creates for an existing Brand
 * Profile that a signed-up workspace owns.
 * The router's base path matches the full namespace passed by the Worker fetch
 * entry; relative endpoint registrations must not receive unmounted URLs.
 */
const controlledProviderRouter = new Hono<{
  Bindings: ApiWorkerEnv;
}>().basePath(controlledProviderRoutePrefix);

/** Provisions supported controlled Channels for an existing workspace Profile; rejects empty names/lists. */
controlledProviderRouter.post("/channels", async (c) => {
  const body = await c.req.json<ProvisionChannelsRequest>();
  const profileName = body.profile_name?.trim();
  if (!profileName) {
    return c.json({ error: "profile_name is required" }, 400);
  }
  const requested = body.channels ?? [];
  if (requested.length === 0) {
    return c.json({ error: "at least one channel is required" }, 400);
  }
  for (const channel of requested) {
    if (!controlledProviderPlatforms.includes(channel.platform as never)) {
      return c.json({ error: `controlled provider does not serve ${channel.platform}` }, 400);
    }
    if (!channel.provider_user_id?.trim()) {
      return c.json({ error: "provider_user_id is required" }, 400);
    }
  }

  try {
    // Encrypted exactly the way the OAuth callback encrypts a real token, so the
    // automation Worker decrypts it through the production credential path. The
    // plaintext is a fixture marker, never a social credential.
    const accessToken = await tokenCipherFor(c.env).encrypt(
      "controlled-provider-token-not-a-social-credential",
    );
    const provisioned = await Effect.runPromise(
      withSystemTransactionEffect(c.env, (client) =>
        Effect.gen(function* () {
          const profile = yield* client.query<{
            id: string;
            org_id: string;
          }>(
            `SELECT id::text AS id, org_id::text AS org_id
               FROM brand_profiles
              WHERE name = $1 AND deleted_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1`,
            [profileName],
          );
          const profile0 = profile.rows[0];
          if (!profile0) {
            return yield* Effect.fail(
              new TypeError(`no active brand profile named ${profileName}`),
            );
          }
          const created: {
            display_name: string;
            id: string;
            platform: string;
            platform_user_id: string;
          }[] = [];
          for (const channel of requested) {
            const inserted = yield* client.query<{
              id: string;
              platform: string;
              platform_user_id: string;
            }>(
              `INSERT INTO platform_accounts (
                 org_id, brand_profile_id, platform, platform_user_id,
                 display_name, access_token, scopes, metadata, connection_status
               )
               VALUES ($1, $2, $3, $4, $5, $6, ARRAY['publish'],
                       '{"fixture": true}'::jsonb, 'connected')
               ON CONFLICT (platform, platform_user_id) DO UPDATE
               SET brand_profile_id = EXCLUDED.brand_profile_id,
                   org_id = EXCLUDED.org_id,
                   display_name = EXCLUDED.display_name,
                   access_token = EXCLUDED.access_token,
                   scopes = EXCLUDED.scopes,
                   metadata = EXCLUDED.metadata,
                   connection_status = EXCLUDED.connection_status,
                   revoked_at = NULL,
                   updated_at = now()
               RETURNING id::text AS id, platform, platform_user_id`,
              [
                profile0.org_id,
                profile0.id,
                channel.platform,
                channel.provider_user_id,
                channel.display_name ?? channel.provider_user_id,
                accessToken,
              ],
            );
            const account = inserted.rows[0];
            if (!account) {
              return yield* Effect.fail(new TypeError("channel provisioning returned no row"));
            }
            created.push({
              display_name: channel.display_name ?? channel.provider_user_id,
              id: account.id,
              platform: account.platform,
              platform_user_id: account.platform_user_id,
            });
          }
          return {
            brand_profile_id: profile0.id,
            channels: created,
            organization_id: profile0.org_id,
          };
        }),
      ),
    );
    return c.json(provisioned, 201);
  } catch (cause) {
    return c.json({ error: cause instanceof Error ? cause.message : "provisioning failed" }, 422);
  }
});

controlledProviderRouter.get("/publications", async (c) => {
  const accountId = c.req.query("account_id")?.trim();
  if (!accountId) {
    return c.json({ error: "account_id is required" }, 400);
  }
  const publications = await readControlledPublications(
    c.env.ASSETS as ControlledProviderBucket,
    accountId,
  );
  return c.json({ publications });
});

controlledProviderRouter.get("/publications/:publicationId/media/:index", async (c) => {
  const publications = await readControlledPublications(
    c.env.ASSETS as ControlledProviderBucket,
    c.req.query("account_id")?.trim() ?? "",
  );
  const publication = publications.find(
    (candidate) => candidate.publicationId === c.req.param("publicationId"),
  );
  const media = publication?.media[Number(c.req.param("index"))];
  if (!publication || !media) {
    return c.json({ error: "no stored copy at that address" }, 404);
  }
  const object = await (
    c.env.ASSETS as ControlledProviderBucket & {
      get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
      } | null>;
    }
  ).get(media.key);
  if (!object) {
    return c.json({ error: "stored media object is gone" }, 404);
  }
  return new Response(await object.arrayBuffer(), {
    headers: {
      "Content-Type": media.contentType,
      "X-Controlled-Checksum": media.checksum,
      "X-Controlled-File-Size": String(media.fileSize),
    },
  });
});

/** Sets an account's deterministic publish-failure count in fixture storage; zero clears the script. */
controlledProviderRouter.post("/scripts", async (c) => {
  const body = await c.req.json<ScriptRequest>();
  const accountId = body.account_id?.trim();
  if (!accountId) {
    return c.json({ error: "account_id is required" }, 400);
  }
  const failNextPublishes = requireCount(body.fail_next_publishes ?? 0, "fail_next_publishes");
  const script = await writeControlledScript(
    c.env.ASSETS as ControlledProviderBucket,
    accountId,
    failNextPublishes === 0 ? null : { failNextPublishes },
  );
  return c.json({ script });
});

controlledProviderRouter.get("/scripts", async (c) => {
  const accountId = c.req.query("account_id")?.trim();
  if (!accountId) {
    return c.json({ error: "account_id is required" }, 400);
  }
  const script = await readControlledScript(c.env.ASSETS as ControlledProviderBucket, accountId);
  return c.json({ script });
});

/**
 * Builds the production API app bound to the controlled Provider registry.
 *
 * The app is created per environment rather than once at module scope because
 * the registry stores and reads its durable publication records through
 * `env.ASSETS`, which workerd only binds once the Worker is constructed. One
 * app per environment keeps the production module-scope singleton behaviour
 * (route table and readiness cache) intact inside a single local isolate.
 *
 * @param env - API Worker bindings for this isolate.
 * @returns The production app wired to the controlled Provider.
 */
function acceptanceApp(env: ApiWorkerEnv) {
  return createApiApp({
    providerRegistry: createControlledProviderRegistry({
      bucket: env.ASSETS as ControlledProviderBucket,
    }),
  });
}

/**
 * Acceptance API Worker entry.
 *
 * Routes the fixture-only namespace to {@link controlledProviderRouter} and
 * delegates everything else — including the not-found fallback and all error
 * envelopes — to the unmodified production app, so acceptance runs observe the
 * same routing behaviour a deployed stack does.
 */
export default {
  /**
   * Handles one HTTP request.
   *
   * @param request - Incoming HTTP request.
   * @param env - API Worker bindings.
   * @param executionContext - Execution context used for logging and continuations.
   * @returns The response produced by the fixture router or the production app.
   */
  fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(controlledProviderRoutePrefix)) {
      return controlledProviderRouter.fetch(request, env, executionContext);
    }
    return acceptanceApp(env).fetch(request, { ...env }, executionContext);
  },
} satisfies ExportedHandler<ApiWorkerEnv>;
