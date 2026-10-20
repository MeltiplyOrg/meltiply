import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import { withSystemTransactionEffect } from "./database";
import { sha256Hex } from "./crypto";
import type { ApiWorkerEnv } from "./env";

/** Actor identity snapshot persisted on every Workspace Audit entry. */
export interface AuditActor {
  displayName: string | null;
  email: string;
  userId: string;
}

/** One administrative action to append to the workspace audit trail. */
export interface WorkspaceAuditEntry {
  action: string;
  actor: AuditActor;
  after?: unknown;
  before?: unknown;
  orgId: string;
  requestId: string;
  targetId: string;
  targetType: string;
}

/**
 * Appends one Workspace Audit entry inside the caller's transaction.
 *
 * The actor identity is snapshotted so later renames and account deletion do
 * not rewrite history. A missing actor user row is permitted for system
 * actions; `actor_email` stays the durable attribution.
 *
 * @param client - Active transaction client (system scope for administration).
 * @param entry - Action, actor snapshot, target, optional state, and request id.
 * @returns Effect resolving after the audit row is written.
 */
export function recordWorkspaceAuditEffect(
  client: EffectTransactionClient,
  entry: WorkspaceAuditEntry,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `INSERT INTO workspace_audit_entries (
         org_id, actor_user_id, actor_email, actor_display_name,
         action, target_type, target_id, before_state, after_state, request_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        entry.orgId,
        entry.actor.userId,
        entry.actor.email,
        entry.actor.displayName,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.requestId,
      ],
    )
    .pipe(Effect.asVoid);
}

/** Narrow internal user fields shared by actor resolution and lifecycle routes. */
export interface InternalActorRow extends Record<string, unknown> {
  display_name: string | null;
  email: string;
  id: string;
  installation_owner: boolean;
  suspended_at: Date | string | null;
}

/**
 * Maps a database user row to the audit actor snapshot.
 *
 * @param row - Internal users row carrying identity and display fields.
 * @returns Snapshot suitable for `recordWorkspaceAuditEffect`.
 */
export function auditActorFrom(
  row: Pick<InternalActorRow, "display_name" | "email" | "id">,
): AuditActor {
  return { displayName: row.display_name, email: row.email, userId: row.id };
}

/**
 * Appends one Workspace Audit entry in its own system transaction.
 *
 * Services that commit their own tenant transaction (Brand Profiles and
 * Channels) call this after success. The entry is best-effort relative to the
 * caller's route: a failure fails the request, matching the administration
 * contract that an unaudited administrative action must not be reported as
 * successful.
 *
 * @param env - Worker environment bindings.
 * @param entry - Action, actor snapshot, target, optional state, and request id.
 * @returns Effect resolving after the audit row is written.
 */
function recordWorkspaceAudit(
  env: ApiWorkerEnv,
  entry: WorkspaceAuditEntry,
): Effect.Effect<void, DatabaseError> {
  return withSystemTransactionEffect(env, (client) => recordWorkspaceAuditEffect(client, entry));
}

/**
 * Records an Audit entry when the invocation has a system database; otherwise
 * skips it for unit-test isolates that never touch PostgreSQL. With a database
 * present the write is strict: a failed audit insert fails the request instead
 * of silently reporting an unaudited administrative action.
 *
 * @param env - Worker environment bindings.
 * @param entry - Audit fields.
 * @returns Effect resolving after the audit row is written or skipped.
 */
export function recordWorkspaceAuditBestEffort(
  env: ApiWorkerEnv,
  entry: WorkspaceAuditEntry,
): Effect.Effect<void, DatabaseError> {
  if (!env.DB_SYSTEM?.connectionString) return Effect.void;
  return recordWorkspaceAudit(env, entry);
}

/**
 * Records an Audit entry for a service-owned idempotent mutation.
 *
 * The entry is keyed by the operation and Idempotency-Key, so an earlier
 * committed mutation whose Audit insert failed can be repaired by replaying the
 * request. Concurrent retries serialize on a transaction-scoped advisory lock
 * and the second sees the existing row. The deterministic request id is
 * distinct from the transport request id because retries legitimately carry a
 * new one.
 *
 * @param env - Worker environment bindings.
 * @param entry - Audit fields without a request id.
 * @param operation - Stable idempotent operation name.
 * @param idempotencyKey - Client-supplied Idempotency-Key.
 * @returns Effect resolving after the audit row exists or the write is skipped.
 */
export function recordWorkspaceAuditOnceBestEffort(
  env: ApiWorkerEnv,
  entry: Omit<WorkspaceAuditEntry, "requestId">,
  operation: string,
  idempotencyKey: string,
): Effect.Effect<void, DatabaseError> {
  if (!env.DB_SYSTEM?.connectionString) return Effect.void;
  return Effect.gen(function* () {
    const digest = yield* Effect.promise(() => sha256Hex(`${operation}\u0000${idempotencyKey}`));
    const requestId = `idempotency:${digest}`;
    yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
        const existing = yield* client.query(
          `SELECT 1 FROM workspace_audit_entries
           WHERE org_id = $1 AND request_id = $2 AND action = $3 AND target_id = $4
           LIMIT 1`,
          [entry.orgId, requestId, entry.action, entry.targetId],
        );
        if (existing.rows.length === 0) {
          yield* recordWorkspaceAuditEffect(client, { ...entry, requestId });
        }
      }),
    );
  });
}

/**
 * Records an Audit entry attributed to an internal user id.
 *
 * OAuth callbacks run without a bearer actor but carry the selecting user id in
 * their durable state. The identity snapshot is read at audit time so history
 * reflects the account as it existed when the action happened.
 *
 * @param env - Worker environment bindings.
 * @param entry - Audit fields plus the acting internal user id.
 * @returns Effect resolving after the audit row is written.
 */
function recordWorkspaceAuditForUser(
  env: ApiWorkerEnv,
  entry: Omit<WorkspaceAuditEntry, "actor"> & { userId: string },
): Effect.Effect<void, DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    client
      .query<InternalActorRow>(
        `SELECT id, email, display_name, installation_owner, suspended_at
         FROM users WHERE id = $1`,
        [entry.userId],
      )
      .pipe(
        Effect.flatMap((result) => {
          const row = result.rows[0];
          if (!row) return Effect.void;
          return recordWorkspaceAuditEffect(client, {
            ...entry,
            actor: auditActorFrom(row),
          });
        }),
      ),
  );
}

/**
 * Records an Audit entry for an internal user when a system database is present.
 *
 * @param env - Worker environment bindings.
 * @param entry - Audit fields plus the acting internal user id.
 * @returns Effect resolving after the audit row is written or skipped.
 */
export function recordWorkspaceAuditForUserBestEffort(
  env: ApiWorkerEnv,
  entry: Omit<WorkspaceAuditEntry, "actor"> & { userId: string },
): Effect.Effect<void, DatabaseError> {
  if (!env.DB_SYSTEM?.connectionString) return Effect.void;
  return recordWorkspaceAuditForUser(env, entry);
}
