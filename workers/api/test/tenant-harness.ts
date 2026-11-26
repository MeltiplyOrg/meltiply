import { randomUUID } from "node:crypto";
import type { SessionClaims } from "@meltiply/auth";
import { Effect } from "effect";

import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import { authenticatedPoolFor, systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";
import type { FakeTenantStore } from "../src/repositories/fake-tenant-repository";
import type { TenantRepository, TenantTransaction } from "../src/repositories/tenant-repository";

export const databaseEnv: ApiWorkerEnv = {
  DB_AUTHENTICATED: { connectionString: process.env.MELTIPLY_DATABASE_TEST_URL! } as Hyperdrive,
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "test",
};

export const database = () => systemPoolFor(databaseEnv);

export async function closeDatabase(): Promise<void> {
  await authenticatedPoolFor(databaseEnv).end();
  await systemPoolFor(databaseEnv).end();
}

const seededMembers = {
  admin: { subject: "auth_user_local_alpha", userId: "10000000-0000-4000-8000-000000000001" },
  editor: { subject: "auth_user_local_gamma", userId: "10000000-0000-4000-8000-000000000003" },
  viewer: { subject: "auth_user_local_delta", userId: "10000000-0000-4000-8000-000000000004" },
} as const;

const roles = ["admin", "editor", "viewer"] as const;

export interface Tenant {
  admin: SessionClaims;
  editor: SessionClaims;
  organizationId: string;
  outsider: SessionClaims;
  viewer: SessionClaims;
}

function tenantOf(organizationId: string): Tenant {
  const claims = (role: (typeof roles)[number]): SessionClaims => ({
    organizationId,
    organizationRole: role,
    subject: seededMembers[role].subject,
    userId: seededMembers[role].userId,
  });
  return {
    admin: claims("admin"),
    editor: claims("editor"),
    organizationId,
    outsider: { ...claims("admin"), subject: "auth_user_local_beta" },
    viewer: claims("viewer"),
  };
}

export async function seedPostgresTenant(): Promise<Tenant> {
  const organizationId = randomUUID();
  await database().query(
    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Round trip', $2)",
    [organizationId, `round-trip-${organizationId}`],
  );
  for (const role of roles) {
    await database().query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)", [
      organizationId,
      seededMembers[role].userId,
      role,
    ]);
  }
  return tenantOf(organizationId);
}

export function seedFakeTenant(store: FakeTenantStore): Tenant {
  const organizationId = randomUUID();
  for (const role of roles) {
    store.members.push({ organizationId, role, subject: seededMembers[role].subject });
  }
  return tenantOf(organizationId);
}

export function inTransaction<Transaction extends TenantTransaction, Value, Failure>(
  repository: TenantRepository<Transaction>,
  session: SessionClaims,
  work: (tx: Transaction) => Effect.Effect<Value, Failure>,
): Promise<Value> {
  return Effect.runPromise(repository.transaction(session, work));
}

export function failureOf<Transaction extends TenantTransaction, Value, Failure>(
  repository: TenantRepository<Transaction>,
  session: SessionClaims,
  work: (tx: Transaction) => Effect.Effect<Value, Failure>,
) {
  return Effect.runPromise(Effect.flip(repository.transaction(session, work)));
}

const contentionWindowMilliseconds = 25;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function contend<Transaction extends TenantTransaction, HeldFailure, Value, Failure>(
  repository: TenantRepository<Transaction>,
  session: SessionClaims,
  holder: {
    lock: (tx: Transaction) => Effect.Effect<unknown, HeldFailure>;
    write: (tx: Transaction) => Effect.Effect<unknown, HeldFailure>;
  },
  contender: (tx: Transaction) => Effect.Effect<Value, Failure>,
): Promise<Value> {
  const locked = signal();
  const contending = signal();
  const contended = signal();
  const first = inTransaction(repository, session, (tx) =>
    Effect.gen(function* () {
      yield* holder.lock(tx);
      locked.resolve();
      yield* Effect.promise(() => contending.promise);
      yield* Effect.promise(() =>
        Promise.race([
          contended.promise,
          new Promise((resolve) => setTimeout(resolve, contentionWindowMilliseconds)),
        ]),
      );
      yield* holder.write(tx);
    }),
  );
  await locked.promise;
  const second = inTransaction(repository, session, (tx) => {
    contending.resolve();
    return contender(tx);
  }).finally(contended.resolve);
  await first;
  return second;
}
