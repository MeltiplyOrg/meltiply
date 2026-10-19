// Disposable-database smoke: run only after test:integration has seeded the
// local database. Exercises production API/storage/processing/retention code;
// only authentication and the Container transport are supplied by this host.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { z } from "zod";
import type { Pool } from "../../packages/database/src/index";
import { createObjectStoreFromEnv, type ObjectStorageEnv } from "../../packages/storage/src/index";
import { createApiApp } from "../../workers/api/src/app";
import { authenticatedPoolFor, systemPoolFor } from "../../workers/api/src/database";
import type { ApiWorkerEnv } from "../../workers/api/src/env";
import { createAssetJobProcessor } from "../../workers/automation/src/assets";
import { systemPoolFor as automationPoolFor } from "../../workers/automation/src/database";
import type { AutomationEnv } from "../../workers/automation/src/env";
import { runRetention } from "../../workers/automation/src/retention";
import { createProviderMediaResolver } from "../../workers/automation/src/provider-media";
import { processNativeJob } from "../lib/processor-client";

const organizationId = "20000000-0000-4000-8000-000000000001";
const subject = "auth_user_local_alpha";
const userId = "10000000-0000-4000-8000-000000000001";
const token = z.string().min(1).parse(process.env.PROCESSOR_JOB_TOKEN);
const endpoint = z.url().parse(process.env.S3_CHECK_ENDPOINT);
const png = readFileSync(z.string().min(1).parse(process.env.S3_CHECK_IMAGE));
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 9091,
    cf: {},
    telemetry: { enabled: false },
    workers: [
      {
        name: "pipeline-r2",
        modules: true,
        compatibilityDate: "2026-07-01",
        compatibilityFlags: [],
        r2Buckets: {
          ASSETS: {
            id: "pipeline-assets",
            s3Credentials: { accessKeyId: "pipeline-access", secretAccessKey: "pipeline-secret" },
          },
        },
        hyperdrives: {
          DB_AUTHENTICATED:
            "postgres://meltiply_rls:meltiply-authenticated-local@127.0.0.1:5433/meltiply?sslmode=disable",
          DB_SYSTEM:
            "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
        },
        script: "export default { fetch() { return new Response('ok'); } };",
      },
    ],
  }),
);
await runtime.ready;
const bindings =
  await runtime.getBindings<
    Required<Pick<ApiWorkerEnv, "ASSETS" | "DB_AUTHENTICATED" | "DB_SYSTEM">>
  >("pipeline-r2");
const providers = [
  {
    ASSETS: bindings.ASSETS,
    R2_ACCOUNT_ID: "pipeline",
    R2_ACCESS_KEY_ID: "pipeline-access",
    R2_SECRET_ACCESS_KEY: "pipeline-secret",
    R2_BUCKET_NAME: "pipeline-assets",
    R2_ENDPOINT: "http://127.0.0.1:9091",
    R2_ENDPOINT_PATH_PREFIX: "/cdn-cgi/local/r2/s3",
  },
  {
    OBJECT_STORAGE_PROVIDER: "s3",
    S3_ACCESS_KEY_ID: "s3-check-access-key",
    S3_SECRET_ACCESS_KEY: "s3-check-secret-key",
    S3_BUCKET: "meltiply-assets",
    S3_ENDPOINT: endpoint,
  },
] satisfies ObjectStorageEnv[];
// Pools are cached by connection settings across both provider iterations.
const pools = new Set<Pool>();

/**
 * Adapts asset-scoped processor lookup to the live private native engine.
 * IDs retain stable name/equality semantics; process returns the production RPC outcome.
 */
const mediaProcessor = {
  idFromName: (name: string): DurableObjectId => ({
    name,
    toString: () => name,
    equals: (other) => other.toString() === name,
  }),
  get: () => ({
    process: (job: Parameters<typeof processNativeJob>[0]) => processNativeJob(job, token),
  }),
} satisfies NonNullable<AutomationEnv["MEDIA_PROCESSOR"]>;

try {
  for (const provider of providers) {
    const storageEnv = { ...provider, ENVIRONMENT: "test" } satisfies Partial<ApiWorkerEnv>;
    const env = {
      ...storageEnv,
      ALLOWED_ORIGINS: "http://localhost:3000",
      VERSION: "storage-pipeline-check",
      TOKEN_ENCRYPTION_KEY: "storage-pipeline-private-media-secret",
      PUBLIC_API_URL: "https://api.storage.example.test",
      DB_AUTHENTICATED: bindings.DB_AUTHENTICATED,
      DB_SYSTEM: bindings.DB_SYSTEM,
    } satisfies ApiWorkerEnv;
    const automationEnv = {
      ...env,
      MEDIA_PROCESSOR: mediaProcessor,
    } satisfies AutomationEnv;
    const app = createApiApp({
      resolveActor: async () => ({
        authUserId: subject,
        claims: { organizationId, organizationRole: "admin", subject, userId },
        role: "admin",
        userId,
        workspace: { id: organizationId, isPersonal: false, name: "Alpha", slug: "alpha" },
      }),
      verifyJwtToken: async () => ({
        email: "alpha@meltiply.local",
        name: "Alpha Creator",
        subject,
      }),
    });
    /** Makes an authenticated mutation/read and rejects unexpected HTTP outcomes. */
    const api = async (path: string, body?: unknown, status = 200): Promise<unknown> => {
      const response = await app.request(
        path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: "Bearer storage-pipeline.jwt",
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );
      const payload: unknown = await response.json().catch(() => null);
      assert.equal(response.status, status, JSON.stringify(payload));
      return payload;
    };
    const pool = systemPoolFor(env);
    try {
      const profile = z
        .object({ id: z.uuid() })
        .parse(
          await api(
            "/api/v1/brand-profiles",
            { name: "Storage switching smoke", color: "#1d4ed8" },
            201,
          ),
        );
      const upload = z
        .object({
          asset: z.object({ id: z.uuid() }),
          upload_session: z.object({
            id: z.uuid(),
            single_upload: z.object({
              url: z.url(),
              method: z.string(),
              headers: z.record(z.string(), z.string()),
            }),
          }),
        })
        .parse(
          await api(
            "/api/v1/asset-upload-sessions",
            {
              asset_type: "image",
              brand_profile_id: profile.id,
              content_type: "image/png",
              file_size: png.length,
              filename: "storage.png",
              title: "Storage switching smoke",
            },
            201,
          ),
        );
      const grant = upload.upload_session.single_upload;
      const put = await fetch(grant.url, {
        method: grant.method,
        headers: grant.headers,
        body: png,
      });
      assert.equal(put.status, 200, await put.text());
      await api(`/api/v1/asset-upload-sessions/${upload.upload_session.id}/complete`, {}, 202);
      const eventSchema = z.object({ id: z.uuid(), payload: z.record(z.string(), z.unknown()) });
      const armed = await pool.query(
        "SELECT id::text, payload FROM outbox_events WHERE aggregate_id = $1 AND topic = 'asset.processing.requested' ORDER BY created_at DESC LIMIT 1",
        [upload.asset.id],
      );
      const event = eventSchema.parse(armed.rows[0]);
      const processor = createAssetJobProcessor(automationEnv);
      assert.equal(
        await Effect.runPromise(
          processor.process({
            type: "outbox.event",
            version: 1,
            topic: "asset.processing.requested",
            aggregate_id: upload.asset.id,
            event_id: event.id,
            organization_id: organizationId,
            payload: event.payload,
          }),
        ),
        "processed",
      );
      const asset = z
        .object({ status: z.literal("ready"), width: z.literal(640), height: z.literal(640) })
        .parse(await api(`/api/v1/assets/${upload.asset.id}`));
      assert.equal(asset.status, "ready");
      const download = z
        .object({ url: z.url() })
        .parse(await api(`/api/v1/assets/${upload.asset.id}/download-url`));
      const delivered = await fetch(download.url);
      assert.equal(delivered.status, 200);
      assert.deepEqual(new Uint8Array(await delivered.arrayBuffer()), new Uint8Array(png));
      const unsigned = new URL(download.url);
      unsigned.search = "";
      const denied = await fetch(unsigned);
      assert.ok(
        denied.status === 400 || denied.status === 403,
        `unsigned private delivery returned ${denied.status}`,
      );
      await denied.body?.cancel();
      const original = await pool.query(
        "SELECT r2_key FROM asset_objects WHERE asset_id = $1 AND kind = 'original' AND status = 'ready'",
        [upload.asset.id],
      );
      const objectKey = z.object({ r2_key: z.string() }).parse(original.rows[0]).r2_key;
      const media = await createProviderMediaResolver(automationEnv)({
        assetId: upload.asset.id,
        assetType: "image",
        contentType: "image/png",
        fileSize: png.length,
        objectKey,
        transferMode: "remote_ingest",
      });
      assert.equal(media.mode, "remote_ingest");
      assert.ok("url" in media);
      const relay = await app.request(media.url, {}, env);
      assert.equal(relay.status, 200);
      assert.deepEqual(new Uint8Array(await relay.arrayBuffer()), new Uint8Array(png));
      const tampered = new URL(media.url);
      tampered.searchParams.set("signature", "invalid");
      const rejected = await app.request(tampered.toString(), {}, env);
      assert.equal(rejected.status, 403);
      const inventory = await pool.query("SELECT r2_key FROM asset_objects WHERE asset_id = $1", [
        upload.asset.id,
      ]);
      const keys = z.array(z.object({ r2_key: z.string() })).parse(inventory.rows);
      // Put this disposable profile into the daily purge's retained state.
      await pool.query(
        "UPDATE brand_profiles SET deleted_at = now() - interval '8 days', purge_at = now() - interval '1 day' WHERE id = $1",
        [profile.id],
      );
      await pool.query(
        "UPDATE asset_objects SET write_hold_until = now() - interval '1 day' WHERE asset_id = $1",
        [upload.asset.id],
      );
      const retention = await Effect.runPromise(runRetention(automationEnv));
      assert.equal(retention.errors, 0);
      const store = createObjectStoreFromEnv(storageEnv);
      for (const { r2_key } of keys) assert.equal(await store.head(r2_key), null);
      const purged = await pool.query("SELECT id FROM brand_profiles WHERE id = $1", [profile.id]);
      assert.equal(purged.rowCount, 0);
      console.log(
        `${provider.OBJECT_STORAGE_PROVIDER ?? "r2"}: upload, promotion, native processing, private delivery, and retention passed`,
      );
    } finally {
      pools.add(authenticatedPoolFor(env));
      pools.add(pool);
      pools.add(automationPoolFor(automationEnv));
    }
  }
} finally {
  for (const pool of pools) await pool.end();
  await runtime.dispose();
}
