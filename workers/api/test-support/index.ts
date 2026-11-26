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
import { errorMessage } from "@meltiply/domain";
import { Effect } from "effect";
import { Hono } from "hono";

interface ChannelRequest {
  display_name: string;
  platform: string;
  provider_user_id: string;
}

interface ProvisionChannelsRequest {
  channels: ChannelRequest[];
  profile_name: string;
}

interface ScriptRequest {
  account_id: string;
  fail_next_publishes?: number;
}

function requireCount(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

const automationScheduledRoute = "/__test__/automation/scheduled";

async function runAutomationScheduledWork(binding: unknown, cron: string): Promise<boolean> {
  if (!binding || typeof binding !== "object" || !("fetch" in binding)) return false;
  const forward = binding.fetch;
  if (typeof forward !== "function") return false;
  const response = await forward.call(
    binding,
    new Request(`https://automation.internal/__test__/scheduled?cron=${encodeURIComponent(cron)}`, {
      method: "POST",
    }),
  );
  return response.status === 204;
}

const controlledProviderRoutePrefix = "/controlled-provider/v1";
const controlledProviderRouter = new Hono<{
  Bindings: ApiWorkerEnv;
}>().basePath(controlledProviderRoutePrefix);

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
    return c.json({ error: errorMessage(cause, "provisioning failed") }, 422);
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

function acceptanceApp(env: ApiWorkerEnv) {
  return createApiApp({
    providerRegistry: createControlledProviderRegistry({
      bucket: env.ASSETS as ControlledProviderBucket,
    }),
  });
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (url.pathname === automationScheduledRoute) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") {
        return new Response(null, { status: 404 });
      }
      const cron = url.searchParams.get("cron") ?? "0 * * * *";
      if (!(await runAutomationScheduledWork(env.AUTOMATION, cron))) {
        return new Response("Automation scheduled work is unavailable.", { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith(controlledProviderRoutePrefix)) {
      return controlledProviderRouter.fetch(request, env, executionContext);
    }
    return acceptanceApp(env).fetch(request, { ...env }, executionContext);
  },
} satisfies ExportedHandler<ApiWorkerEnv>;
