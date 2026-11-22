import { Effect } from "effect";
import { DatabaseError, errorMessage, InvalidRequestError } from "@meltiply/domain";
import { Pool, type PoolConfig, type QueryResult } from "pg";

interface AuthenticatedClaims {
  org_id?: string;
  org_role?: string;
  sub: string;
}

export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface TransactionClient extends Queryable {
  release(destroy?: boolean): void;
}

interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

interface HyperdriveBinding {
  connectionString: string;
}

interface HyperdrivePoolOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  max?: number;
  maxUses?: number;
}

const defaultPoolOptions: PoolConfig = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
};

/** Throws `TypeError` for a blank connection string. */
export function createHyperdrivePool(
  binding: HyperdriveBinding,
  options: HyperdrivePoolOptions = {},
): Pool {
  if (!binding.connectionString.trim()) {
    throw new TypeError("Hyperdrive connectionString is required");
  }
  return new Pool({
    connectionString: binding.connectionString,
    ...defaultPoolOptions,
    ...options,
  });
}

/**
 * Resolver that reuses one pool per isolate and connection string, except in `local` or
 * `DATABASE_POOL_MODE=request` runs, where each call gets a fresh pool whose clients close on
 * release so no socket outlives the request.
 */
export function createHyperdrivePoolCache(
  label: string,
): (
  binding: HyperdriveBinding | undefined,
  env: { readonly DATABASE_POOL_MODE?: string; readonly ENVIRONMENT?: string },
) => Pool {
  let cachedPool: Pool | undefined;
  let cachedConnectionString: string | undefined;

  return (binding, env) => {
    if (!binding) {
      throw new Error(`${label} Hyperdrive binding is unavailable`);
    }
    if (env.ENVIRONMENT === "local" || env.DATABASE_POOL_MODE === "request") {
      return createHyperdrivePool(binding, { maxUses: 1 });
    }
    if (!cachedPool || cachedConnectionString !== binding.connectionString) {
      cachedPool = createHyperdrivePool(binding);
      cachedConnectionString = binding.connectionString;
    }
    return cachedPool;
  };
}

/** JSON for `request.jwt.claims`; throws `TypeError` for a blank subject and omits blank optional claims. */
export function serializeAuthenticatedClaims(claims: AuthenticatedClaims): string {
  const subject = claims.sub.trim();
  const organizationId = claims.org_id?.trim();
  const organizationRole = claims.org_role?.trim();
  if (!subject) {
    throw new TypeError("authenticated database claims require sub");
  }
  return JSON.stringify({
    ...(organizationId ? { org_id: organizationId } : {}),
    ...(organizationRole ? { org_role: organizationRole } : {}),
    sub: subject,
  });
}

export interface EffectTransactionClient {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Effect.Effect<QueryResult<Row>, DatabaseError>;
}

function databaseCall<A>(fallback: string, run: () => Promise<A>): Effect.Effect<A, DatabaseError> {
  return Effect.tryPromise({
    catch: (cause) => new DatabaseError({ cause, message: errorMessage(cause, fallback) }),
    try: run,
  });
}

function wrapTransactionClient(client: TransactionClient): EffectTransactionClient {
  return {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => databaseCall("Database query failed", () => client.query<Row>(text, values)),
  };
}

/**
 * Runs `operation` inside BEGIN/COMMIT on one pooled client, rolling back on failure. The client
 * is destroyed instead of reused when the rollback or the commit fails, since its session state is
 * then unknown.
 */
export function withTransactionEffect<A, E, R>(
  pool: TransactionPool,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return Effect.suspend(() => {
    let reusable = true;
    const discard = Effect.sync(() => {
      reusable = false;
    });
    const rollback = (client: TransactionClient) =>
      databaseCall("Failed to roll back database transaction", () => client.query("ROLLBACK")).pipe(
        Effect.catch(() => discard),
        Effect.asVoid,
        Effect.uninterruptible,
      );
    return Effect.acquireUseRelease(
      databaseCall("Failed to acquire database connection", () => pool.connect()),
      (client) =>
        databaseCall("Failed to begin database transaction", () => client.query("BEGIN")).pipe(
          Effect.andThen(() => operation(wrapTransactionClient(client))),
          Effect.onError(() => rollback(client)),
          Effect.tap(() =>
            databaseCall("Failed to commit database transaction", () =>
              client.query("COMMIT"),
            ).pipe(Effect.onError(() => Effect.andThen(rollback(client), discard))),
          ),
        ),
      (client) => Effect.sync(() => client.release(!reusable)),
    );
  });
}

/**
 * `withTransactionEffect` with `request.jwt.claims` and `statement_timeout` (default 10 s) set
 * transaction-locally so PostgreSQL row-level security sees the tenant.
 */
export function withAuthenticatedTransactionEffect<A, E, R>(
  pool: TransactionPool,
  claims: AuthenticatedClaims,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
  options?: { readonly statementTimeoutMs?: number },
): Effect.Effect<A, E | DatabaseError | InvalidRequestError, R> {
  let serializedClaims: string;
  try {
    serializedClaims = serializeAuthenticatedClaims(claims);
  } catch (cause) {
    return Effect.fail(
      new InvalidRequestError({ message: errorMessage(cause, "Invalid claims for tenant") }),
    );
  }
  const timeoutMs = options?.statementTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Effect.fail(
      new InvalidRequestError({ message: "statementTimeoutMs must be a positive safe integer" }),
    );
  }
  return withTransactionEffect(pool, (client) =>
    client
      .query(
        "SELECT set_config('request.jwt.claims', $1, true), set_config('statement_timeout', $2, true)",
        [serializedClaims, String(timeoutMs)],
      )
      .pipe(Effect.andThen(() => operation(client))),
  );
}

export type { Pool };
