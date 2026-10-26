import { Context, Effect, Layer, type Scope } from "effect";
import { DatabaseError, InvalidRequestError } from "@meltiply/domain";
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

export interface AuthenticatedClaims {
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

export interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

export interface HyperdriveBinding {
  connectionString: string;
}

export interface HyperdrivePoolOptions {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  max?: number;
}

const defaultPoolOptions: Required<HyperdrivePoolOptions> = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
};

/**
 * Closes checked-out clients on release for pools whose sockets must not
 * outlive a request. Managed Cloudflare isolates reuse module-scoped pools;
 * local and standalone workerd runtimes use this helper for request-owned
 * pools. Hyperdrive continues pooling origin connections independently.
 *
 * Preserves both node-postgres connect overloads: Pool.query uses the callback
 * form internally, while transactions await the Promise form. Both receive
 * the same destruction release hook, including query-error releases.
 *
 * @param pool - PostgreSQL pool to patch.
 * @returns The same pool; every released connection is closed.
 */
export function destroyClientsOnRelease(pool: Pool): Pool {
  const connect = pool.connect.bind(pool);
  const destroyOnRelease = (client: PoolClient) => {
    const release = client.release.bind(client);
    client.release = () => release(true);
    return client;
  };
  type ConnectCallback = (
    error: Error | undefined,
    client: PoolClient | undefined,
    done: (release?: boolean) => void,
  ) => void;
  function connectAndDestroy(): Promise<PoolClient>;
  function connectAndDestroy(callback: ConnectCallback): void;
  /** Adapts both pg checkout forms without dropping Pool.query's callback. */
  function connectAndDestroy(callback?: ConnectCallback): Promise<PoolClient> | void {
    if (callback) {
      connect((error, client, done) => {
        if (error || !client) {
          callback(error, client, done);
          return;
        }
        destroyOnRelease(client);
        callback(undefined, client, client.release);
      });
      return;
    }
    return connect().then(destroyOnRelease);
  }
  pool.connect = connectAndDestroy;
  return pool;
}

/**
 * Creates a node-postgres Pool configured for a Cloudflare Hyperdrive connection.
 * Applies connection pooling defaults (5s connect timeout, 30s idle timeout, max 10 clients)
 * while allowing caller overrides.
 *
 * @param binding - Hyperdrive binding object supplying the proxy connection string.
 * @param options - Optional pool sizing and timeout overrides.
 * @returns Configured node-postgres Pool instance.
 * @throws {TypeError} When binding connectionString is empty or blank.
 */
export function createHyperdrivePool(
  binding: HyperdriveBinding,
  options: HyperdrivePoolOptions = {},
): Pool {
  if (!binding.connectionString.trim()) {
    throw new TypeError("Hyperdrive connectionString is required");
  }
  const config: PoolConfig = {
    connectionString: binding.connectionString,
    ...defaultPoolOptions,
    ...options,
  };
  return new Pool(config);
}

/**
 * Serializes authenticated user and tenant claims to a JSON string for PostgreSQL RLS.
 * Formats subject (`sub`), optional organization ID (`org_id`), and optional role (`org_role`)
 * for use in `set_config('request.jwt.claims', ..., true)`.
 *
 * @param claims - Authenticated tenant identity claims.
 * @returns JSON string representation of non-empty claims.
 * @throws {TypeError} If subject (`sub`) is missing or whitespace-only.
 */
export function serializeAuthenticatedClaims(claims: AuthenticatedClaims): string {
  const subject = claims.sub.trim();
  const organizationId = claims.org_id?.trim();
  if (!subject) {
    throw new TypeError("authenticated database claims require sub");
  }
  return JSON.stringify({
    ...(organizationId ? { org_id: organizationId } : {}),
    ...(claims.org_role?.trim() ? { org_role: claims.org_role.trim() } : {}),
    sub: subject,
  });
}

/**
 * Effect-based database query client avoiding raw promises.
 * Encapsulates parameterized SQL execution returning typed QueryResult wrapped in DatabaseError.
 */
export interface EffectTransactionClient {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Effect.Effect<QueryResult<Row>, DatabaseError>;
}

/**
 * Wraps a raw driver TransactionClient into an EffectTransactionClient.
 * Safely lifts query execution into an Effect and maps database errors to DatabaseError.
 *
 * @param client - Raw PostgreSQL TransactionClient.
 * @returns EffectTransactionClient wrapping queries in typed Effects.
 */
export function wrapTransactionClient(client: TransactionClient): EffectTransactionClient {
  return {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) =>
      Effect.tryPromise({
        catch: (cause) =>
          new DatabaseError({
            cause,
            message: cause instanceof Error ? cause.message : "Database query failed",
          }),
        try: async () => client.query<Row>(text, values),
      }),
  };
}

/**
 * Acquires a database connection client scoped to the enclosing Effect Scope.
 * Automatically releases the client back to the pool when the Scope closes.
 *
 * @param pool - Transaction pool to acquire connection from.
 * @returns Scoped Effect resolving to the connected EffectTransactionClient.
 */
export function acquireClient(
  pool: TransactionPool,
): Effect.Effect<EffectTransactionClient, DatabaseError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      catch: (cause) =>
        new DatabaseError({
          cause,
          message: cause instanceof Error ? cause.message : "Failed to acquire database connection",
        }),
      try: async () => pool.connect(),
    }),
    (client) =>
      Effect.sync(() => {
        client.release();
      }),
  ).pipe(Effect.map(wrapTransactionClient));
}

/**
 * Executes an effectful operation within a managed PostgreSQL transaction block (BEGIN / COMMIT / ROLLBACK).
 * Manages connection acquisition, transaction lifecycle, and connection destruction on rollback failure.
 *
 * @param pool - Database transaction pool.
 * @param operation - Function returning an Effect given the EffectTransactionClient.
 * @returns Effect resolving to the operation's result or failing with the operation's error or DatabaseError.
 */
export function withTransactionEffect<A, E, R>(
  pool: TransactionPool,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return Effect.gen(function* () {
    const client = yield* Effect.tryPromise({
      catch: (cause) =>
        new DatabaseError({
          cause,
          message: cause instanceof Error ? cause.message : "Failed to acquire database connection",
        }),
      try: async () => pool.connect(),
    });

    let destroyClient = false;
    const effectClient = wrapTransactionClient(client);

    const transactionProgram = Effect.gen(function* () {
      yield* Effect.tryPromise({
        catch: (cause) =>
          new DatabaseError({
            cause,
            message:
              cause instanceof Error ? cause.message : "Failed to begin database transaction",
          }),
        try: async () => client.query("BEGIN"),
      });

      const rollback = Effect.uninterruptible(
        Effect.exit(
          Effect.tryPromise({
            catch: () => {
              destroyClient = true;
            },
            try: async () => client.query("ROLLBACK"),
          }),
        ),
      );

      const opExit = yield* Effect.exit(operation(effectClient));
      if (opExit._tag === "Success") {
        const commitExit = yield* Effect.exit(
          Effect.tryPromise({
            catch: (cause) =>
              new DatabaseError({
                cause,
                message:
                  cause instanceof Error ? cause.message : "Failed to commit database transaction",
              }),
            try: async () => client.query("COMMIT"),
          }),
        );
        if (commitExit._tag === "Failure") {
          yield* rollback;
          destroyClient = true;
          return yield* Effect.failCause(commitExit.cause);
        }
        return opExit.value;
      } else {
        yield* rollback;
        return yield* Effect.failCause(opExit.cause);
      }
    });

    return yield* transactionProgram.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (destroyClient) {
            client.release(true);
          } else {
            client.release();
          }
        }),
      ),
    );
  });
}

/**
 * Executes a tenant database operation within an authenticated transaction with PostgreSQL RLS.
 * Sets `request.jwt.claims` and statement_timeout on the transaction as local session parameters.
 *
 * @param pool - Database transaction pool.
 * @param claims - Tenant identity claims for RLS enforcement.
 * @param operation - Function returning an Effect given the EffectTransactionClient.
 * @returns Effect resolving to operation result or failing with DatabaseError or operation error.
 */
export function withAuthenticatedTransactionEffect<A, E, R>(
  pool: TransactionPool,
  claims: AuthenticatedClaims,
  operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError | InvalidRequestError, R> {
  let serializedClaims: string;
  try {
    serializedClaims = serializeAuthenticatedClaims(claims);
  } catch (cause) {
    return Effect.fail(
      new InvalidRequestError({
        message: cause instanceof Error ? cause.message : "Invalid claims for tenant",
      }),
    );
  }

  return withTransactionEffect(pool, (client) =>
    client
      .query(
        "SELECT set_config('request.jwt.claims', $1, true), set_config('statement_timeout', '10000', true)",
        [serializedClaims],
      )
      .pipe(Effect.flatMap(() => operation(client))),
  );
}

/**
 * Service shape describing effectful database transactions and connection acquisition.
 */
export interface DatabaseServiceShape {
  readonly acquireClient: () => Effect.Effect<EffectTransactionClient, DatabaseError, Scope.Scope>;
  readonly withAuthenticatedTransaction: <A, E, R>(
    claims: AuthenticatedClaims,
    operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError | InvalidRequestError, R>;
  readonly withTransaction: <A, E, R>(
    operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>;
}

/**
 * Effect service tag for PostgreSQL database transactions and connection pooling.
 */
export class DatabaseService extends Context.Service<DatabaseService, DatabaseServiceShape>()(
  "DatabaseService",
) {}

/**
 * Type guard verifying whether a candidate object satisfies the HyperdriveBinding contract.
 * Checks for a non-empty string connectionString property to prevent unvalidated casts.
 *
 * @param candidate - Untrusted candidate object or connection binding.
 * @returns True if candidate has a valid connectionString property, false otherwise.
 */
function isHyperdriveBinding(candidate: unknown): candidate is HyperdriveBinding {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "connectionString" in candidate &&
    typeof candidate.connectionString === "string"
  );
}

/**
 * Creates a live production Layer for DatabaseService backed by PostgreSQL/Hyperdrive.
 * Supports passing an active TransactionPool or HyperdriveBinding, failing closed if pool creation fails.
 *
 * @param poolOrBinding - Active TransactionPool instance or Hyperdrive connection binding.
 * @param options - Optional pool sizing and timeout configuration.
 * @returns Layer providing the production DatabaseService.
 */
export function createDatabaseServiceLive(
  poolOrBinding: TransactionPool | HyperdriveBinding,
  options?: HyperdrivePoolOptions,
): Layer.Layer<DatabaseService, never, never> {
  let pool: TransactionPool | undefined;
  let initError: string | undefined;

  if ("connect" in poolOrBinding && typeof poolOrBinding.connect === "function") {
    pool = poolOrBinding;
  } else if (isHyperdriveBinding(poolOrBinding)) {
    try {
      pool = createHyperdrivePool(poolOrBinding, options);
    } catch (cause) {
      initError = cause instanceof Error ? cause.message : "Failed to initialize database pool";
    }
  } else {
    initError = "Invalid Hyperdrive configuration binding";
  }

  const requirePool = (): Effect.Effect<TransactionPool, DatabaseError> => {
    if (initError || !pool) {
      return Effect.fail(
        new DatabaseError({
          message: initError ?? "Database service is unconfigured",
        }),
      );
    }
    return Effect.succeed(pool);
  };

  const service: DatabaseServiceShape = {
    acquireClient: () => requirePool().pipe(Effect.flatMap((p) => acquireClient(p))),
    withAuthenticatedTransaction: (claims, operation) =>
      requirePool().pipe(
        Effect.flatMap((p) => withAuthenticatedTransactionEffect(p, claims, operation)),
      ),
    withTransaction: (operation) =>
      requirePool().pipe(Effect.flatMap((p) => withTransactionEffect(p, operation))),
  };

  return Layer.succeed(DatabaseService, service);
}

/**
 * Creates a test Layer for DatabaseService with in-memory transaction doubles or custom overrides.
 * Provides safe empty query responses for transactions and scoped clients in unit tests.
 *
 * @param impl - Optional partial implementation overrides.
 * @returns Layer providing test DatabaseService.
 */
export function createDatabaseServiceTest(
  impl?: Partial<DatabaseServiceShape>,
): Layer.Layer<DatabaseService, never, never> {
  const dummyClient: EffectTransactionClient = {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>() =>
      Effect.succeed({
        command: "SELECT",
        fields: [],
        oid: 0,
        rowCount: 0,
        rows: [] as Row[],
      }),
  };

  const service: DatabaseServiceShape = {
    acquireClient: impl?.acquireClient ?? (() => Effect.succeed(dummyClient)),
    withAuthenticatedTransaction:
      impl?.withAuthenticatedTransaction ?? ((_claims, operation) => operation(dummyClient)),
    withTransaction: impl?.withTransaction ?? ((operation) => operation(dummyClient)),
  };

  return Layer.succeed(DatabaseService, service);
}

export type { Pool, PoolClient };
