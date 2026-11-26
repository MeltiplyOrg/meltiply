import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { ObjectStore } from "@meltiply/storage";

import { withSystemTransactionEffect } from "./database";
import type { AutomationEnv } from "./env";
import { toError } from "./errors";

export interface ClaimedAssetObject extends Record<string, unknown> {
  asset_id: string;
  bytes: number | string | null;
  id: string;
  kind: string;
  org_id: string;
  r2_key: string;
  reserved_bytes: number | string | null;
  status: string;
}

export interface ObjectCleanupOutcome {
  readonly deletedObjects: number;
  readonly errors: number;
  readonly firstError: Error | undefined;
  readonly releasedBytes: number;
}

const OBJECT_DELETE_CONCURRENCY = 8;

export function claimObjectsForDeletion(
  env: AutomationEnv,
  options: {
    assetIds?: readonly string[];
    brandProfileIds?: readonly string[];
  },
): Effect.Effect<ClaimedAssetObject[], DatabaseError> {
  const assetIds = options.assetIds ?? [];
  const brandProfileIds = options.brandProfileIds ?? [];
  if (assetIds.length === 0 && brandProfileIds.length === 0) {
    return Effect.succeed([]);
  }
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<ClaimedAssetObject>(
        `UPDATE asset_objects AS object
         SET status = 'deleting', updated_at = now()
         WHERE object.status IN (
                 'ready', 'superseded', 'writing', 'deleting'
               )
           AND (
             object.write_hold_until IS NULL
             OR object.write_hold_until <= now()
           )
           AND (
             object.asset_id = ANY($1::uuid[])
             OR object.asset_id IN (
               SELECT asset.id
               FROM assets AS asset
               WHERE asset.brand_profile_id = ANY($2::uuid[])
             )
           )
         RETURNING object.id, object.asset_id, object.org_id, object.kind,
                   object.r2_key, object.bytes, object.reserved_bytes,
                   object.status`,
        [assetIds, brandProfileIds],
      )
      .pipe(Effect.map((result) => result.rows)),
  );
}

export function settleDeletedObjects(
  env: AutomationEnv,
  rows: readonly { id: string }[],
): Effect.Effect<{ deleted_objects: number; released_bytes: number }, DatabaseError> {
  if (rows.length === 0) {
    return Effect.succeed({ deleted_objects: 0, released_bytes: 0 });
  }
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<{ deleted_objects: number; released_bytes: number }>(
        `WITH settled AS (
           UPDATE asset_objects AS object
           SET status = 'deleted',
               deleted_at = now(),
               updated_at = now()
           WHERE object.id = ANY($1::uuid[])
             AND object.status = 'deleting'
           RETURNING object.org_id,
                     GREATEST(COALESCE(object.bytes, 0),
                              COALESCE(object.reserved_bytes, 0))::bigint
                       AS charged_bytes
         ), released AS (
           UPDATE usage_records AS usage
           SET storage_bytes = GREATEST(
                 usage.storage_bytes - release.charged_bytes, 0
               ),
               updated_at = now()
           FROM (
             SELECT settled.org_id,
                    SUM(settled.charged_bytes)::bigint AS charged_bytes
             FROM settled
             GROUP BY settled.org_id
           ) AS release
           WHERE usage.org_id = release.org_id
             AND usage.period = to_char(now(), 'YYYY-MM')
           RETURNING release.charged_bytes
         )
         SELECT (SELECT COUNT(*)::integer FROM settled) AS deleted_objects,
                (SELECT COALESCE(SUM(charged_bytes), 0)::bigint FROM settled)
                  AS released_bytes`,
        [rows.map((row) => row.id)],
      )
      .pipe(Effect.map((result) => result.rows[0] ?? { deleted_objects: 0, released_bytes: 0 })),
  );
}

export function deleteStorageObjectEffect(
  storage: Pick<ObjectStore, "delete" | "head">,
  key: string,
  options?: { checkBeforeDelete?: boolean },
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (options?.checkBeforeDelete) {
      const present = yield* Effect.match(
        Effect.tryPromise({ catch: toError, try: () => storage.head(key) }),
        { onFailure: () => true, onSuccess: (object) => object !== null },
      );
      if (!present) return;
    }
    yield* Effect.tryPromise({
      catch: toError,
      try: () => storage.delete(key),
    });
  });
}

export interface StorageDeleteBatchOutcome {
  readonly deletedIds: Array<{ id: string }>;
  readonly errors: number;
  readonly firstError: Error | undefined;
}

export function deleteStorageObjectsEffect(
  storage: Pick<ObjectStore, "delete" | "head">,
  objects: readonly { id: string; r2_key: string }[],
  options?: { checkBeforeDelete?: boolean },
): Effect.Effect<StorageDeleteBatchOutcome> {
  return Effect.gen(function* () {
    if (objects.length === 0) {
      return { deletedIds: [], errors: 0, firstError: undefined };
    }
    const outcomes = yield* Effect.forEach(
      objects,
      (object) =>
        Effect.match(
          deleteStorageObjectEffect(storage, object.r2_key, {
            checkBeforeDelete: options?.checkBeforeDelete,
          }),
          {
            onFailure: (error) => ({ error, id: null as string | null }),
            onSuccess: () => ({ error: undefined as Error | undefined, id: object.id }),
          },
        ),
      { concurrency: OBJECT_DELETE_CONCURRENCY },
    );
    const deletedIds: Array<{ id: string }> = [];
    let firstError: Error | undefined;
    let errors = 0;
    for (const outcome of outcomes) {
      if (outcome.id !== null) {
        deletedIds.push({ id: outcome.id });
      } else {
        errors += 1;
        firstError ??= outcome.error;
      }
    }
    return { deletedIds, errors, firstError };
  });
}

export function deleteObjectsAndSettleEffect(
  env: AutomationEnv,
  storage: Pick<ObjectStore, "delete" | "head">,
  objects: readonly { id: string; r2_key: string }[],
  options?: {
    checkBeforeDelete?: boolean;
    failOnSettlementError?: boolean;
  },
): Effect.Effect<ObjectCleanupOutcome, DatabaseError> {
  return Effect.gen(function* () {
    const { deletedIds, errors, firstError } = yield* deleteStorageObjectsEffect(storage, objects, {
      checkBeforeDelete: options?.checkBeforeDelete,
    });
    if (deletedIds.length === 0) {
      return {
        deletedObjects: 0,
        errors,
        firstError,
        releasedBytes: 0,
      };
    }
    if (options?.failOnSettlementError !== false) {
      const settled = yield* settleDeletedObjects(env, deletedIds);
      return {
        deletedObjects: settled.deleted_objects,
        errors,
        firstError,
        releasedBytes: settled.released_bytes,
      };
    }
    const settled = yield* Effect.match(settleDeletedObjects(env, deletedIds), {
      onFailure: (cause) => ({
        error: toError(cause),
        settled: undefined as { deleted_objects: number; released_bytes: number } | undefined,
      }),
      onSuccess: (result) => ({
        error: undefined as Error | undefined,
        settled: result,
      }),
    });
    return {
      deletedObjects: settled.settled?.deleted_objects ?? 0,
      errors: errors + (settled.error ? 1 : 0),
      firstError: firstError ?? settled.error,
      releasedBytes: settled.settled?.released_bytes ?? 0,
    };
  });
}
