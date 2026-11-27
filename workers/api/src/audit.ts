import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { ResolvedActor } from "./actor-types";
import { withSystemTransactionEffect } from "./database";
import { sha256Hex } from "./crypto";
import type { ApiWorkerEnv } from "./env";

interface AuditActor {
  displayName: string | null;
  email: string;
  userId: string;
}

interface WorkspaceAuditEntry {
  action: string;
  actor: AuditActor;
  after?: unknown;
  before?: unknown;
  orgId: string;
  requestId: string;
  targetId: string;
  targetType: string;
}

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

interface InternalActorRow extends Record<string, unknown> {
  display_name: string | null;
  email: string;
  id: string;
}

export function auditActorFrom(row: InternalActorRow): AuditActor {
  return { displayName: row.display_name, email: row.email, userId: row.id };
}

export function auditActorFromResolved(actor: ResolvedActor): AuditActor {
  return { displayName: actor.displayName, email: actor.email, userId: actor.userId };
}

export function recordWorkspaceAuditBestEffort(
  env: ApiWorkerEnv,
  entry: WorkspaceAuditEntry,
): Effect.Effect<void, DatabaseError> {
  if (!env.DB_SYSTEM?.connectionString) return Effect.void;
  return withSystemTransactionEffect(env, (client) => recordWorkspaceAuditEffect(client, entry));
}

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
