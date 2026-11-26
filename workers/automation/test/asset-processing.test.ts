import type { EffectTransactionClient } from "@meltiply/database";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import {
  failAssetInTransaction,
  processAssetMedia,
  releaseStaleProcessingStaging,
} from "../src/asset-processing";
import { rearmStuckAssetJobs } from "../src/assets";
import { TerminalJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { fakeObjectStore, fakeTransactionClient } from "./test-doubles";

const baseEnv: AutomationEnv = { ENVIRONMENT: "test", VERSION: "test" };

describe("asset processing", () => {
  it("fails an unsupported asset type as a terminal job error without defecting", async () => {
    const query = vi.fn(() =>
      Effect.succeed({
        rows: [
          {
            asset_type: "document",
            brand_profile_id: "profile",
            file_size: 10,
            id: "asset",
            mime_type: "application/pdf",
            org_id: "org",
            source_etag: null,
            source_sha256: null,
            status: "processing",
          },
        ],
      }),
    );
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) => operation(fakeTransactionClient(query)),
    );

    const exit = await Effect.runPromiseExit(
      processAssetMedia(baseEnv, fakeObjectStore(), "asset", "org"),
    );

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(TerminalJobError);
  });

  it("skips assets that are no longer processing and rejects missing media types", async () => {
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient(() =>
            Effect.succeed({
              rows: [{ id: "asset", status: "ready" }],
            }),
          ),
        ),
    );
    await expect(
      Effect.runPromise(processAssetMedia(baseEnv, fakeObjectStore(), "asset", "org")),
    ).resolves.toBe("skipped");

    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient(() =>
            Effect.succeed({
              rows: [
                {
                  asset_type: "image",
                  brand_profile_id: "profile",
                  file_size: 10,
                  id: "asset",
                  mime_type: null,
                  org_id: "org",
                  source_etag: null,
                  source_sha256: null,
                  status: "processing",
                },
              ],
            }),
          ),
        ),
    );
    const exit = await Effect.runPromiseExit(
      processAssetMedia(baseEnv, fakeObjectStore(), "asset", "org"),
    );
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      code: "declared_media_type_missing",
    });
  });

  it("marks asset failure, supersedes reservations, and arms the orphan clock in one transaction", async () => {
    const statements: string[] = [];
    const client = fakeTransactionClient((sql) => {
      statements.push(sql);
      return Effect.succeed({ rowCount: 1, rows: [] });
    });

    await Effect.runPromise(
      failAssetInTransaction(client, "asset-1", undefined, {
        code: "declared_media_type_missing",
        message: "Missing type",
      }),
    );
    expect(statements.some((sql) => sql.includes("orphan_delete_after"))).toBe(true);
    expect(
      statements.some((sql) => sql.includes("WHERE asset_id = $1 AND status = 'processing'")),
    ).toBe(true);

    statements.length = 0;
    await Effect.runPromise(
      failAssetInTransaction(
        client,
        "asset-1",
        { objectId: "obj-1", renditionId: "rend-1" },
        { code: "processing_failed", message: "Failed" },
      ),
    );
    expect(statements.some((sql) => sql.includes("WHERE id = $1 AND status = 'processing'"))).toBe(
      true,
    );
  });

  it("reclaims stale processing staging objects concurrently and settles only confirmed deletes", async () => {
    const deleted: string[] = [];
    const settledIds: unknown[][] = [];
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient((sql, values) => {
            if (sql.includes("RETURNING id, r2_key")) {
              return Effect.succeed({
                rows: [
                  { id: "obj-1", r2_key: "staging/org/asset/1" },
                  { id: "obj-2", r2_key: "staging/org/asset/2" },
                ],
              });
            }
            settledIds.push(values ? [...values] : []);
            return Effect.succeed({ rows: [{ deleted_objects: 1, released_bytes: 100 }] });
          }),
        ),
    );
    const store = fakeObjectStore({
      delete: vi.fn(async (key: string) => {
        if (key.endsWith("/2")) throw new Error("transient storage error");
        deleted.push(key);
      }),
      head: vi.fn(async (key: string) => ({
        contentType: "video/mp4",
        etag: "e1",
        key,
        size: 100,
        uploadedAt: new Date("2026-08-15T12:00:00Z"),
      })),
    });

    const released = await Effect.runPromise(releaseStaleProcessingStaging(baseEnv, store, 10));
    expect(released).toBe(1);
    expect(deleted).toEqual(["staging/org/asset/1"]);
    expect(settledIds[0]).toEqual([["obj-1"]]);
  });

  it("re-arms stuck asset jobs using the revive conflict clause", async () => {
    const queries: string[] = [];
    withSystemTransactionEffect.mockImplementation(
      (
        _env: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<unknown>,
      ) =>
        operation(
          fakeTransactionClient((sql) => {
            queries.push(sql);
            return Effect.succeed({ rowCount: 2, rows: [] });
          }),
        ),
    );

    const armed = await Effect.runPromise(rearmStuckAssetJobs(baseEnv));
    expect(armed).toBe(2);
    expect(queries[0]).toContain("SET id = gen_random_uuid()");
  });
});
