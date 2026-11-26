import { DatabaseError, InvalidRequestError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  createHyperdrivePool,
  createHyperdrivePoolCache,
  withAuthenticatedTransactionEffect,
  withTransactionEffect,
  type EffectTransactionClient,
  type TransactionClient,
} from "../src";

class FakeClient implements TransactionClient {
  readonly statements: string[] = [];
  readonly values: (readonly unknown[] | undefined)[] = [];
  readonly releases: boolean[] = [];
  readonly failures = new Map<string, unknown>();

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.statements.push(text);
    this.values.push(values);
    if (this.failures.has(text)) throw this.failures.get(text);
    return { command: "SELECT", fields: [], oid: 0, rowCount: 0, rows: [] as Row[] };
  }

  release(destroy = false) {
    this.releases.push(destroy);
  }
}

function setup() {
  const client = new FakeClient();
  const pool = { connect: async () => client };
  return { client, pool };
}

const selectOne = (tx: EffectTransactionClient) =>
  tx.query("SELECT 1").pipe(Effect.map(() => "done"));
const CLAIMS_STATEMENT =
  "SELECT set_config('request.jwt.claims', $1, true), set_config('statement_timeout', $2, true)";
const REUSED = [false];
const DESTROYED = [true];

describe("withTransactionEffect", () => {
  it("an operation that succeeds", async () => {
    const { client, pool } = setup();

    const result = await Effect.runPromise(withTransactionEffect(pool, selectOne));

    expect(result).toEqual("done");
    expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(client.releases).toEqual(REUSED);
  });

  it("an operation that fails", async () => {
    const { client, pool } = setup();
    const failure = new Error("operation error");

    const error = await Effect.runPromise(
      Effect.flip(withTransactionEffect(pool, () => Effect.fail(failure))),
    );

    expect(error).toBe(failure);
    expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual(REUSED);
  });

  it("an interrupted operation", async () => {
    const { client, pool } = setup();

    const exit = await Effect.runPromiseExit(withTransactionEffect(pool, () => Effect.interrupt));

    expect(exit._tag).toEqual("Failure");
    expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual(REUSED);
  });

  it("a rollback that fails", async () => {
    const { client, pool } = setup();
    client.failures.set("ROLLBACK", new Error("rollback failed"));
    const failure = new Error("operation error");

    const error = await Effect.runPromise(
      Effect.flip(withTransactionEffect(pool, () => Effect.fail(failure))),
    );

    expect(error).toBe(failure);
    expect(client.releases).toEqual(DESTROYED);
  });

  it("a commit that fails", async () => {
    const { client, pool } = setup();
    const failure = new Error("commit failed");
    client.failures.set("COMMIT", failure);

    const error = await Effect.runPromise(Effect.flip(withTransactionEffect(pool, selectOne)));

    expect(error).toEqual(new DatabaseError({ cause: failure, message: "commit failed" }));
    expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT", "ROLLBACK"]);
    expect(client.releases).toEqual(DESTROYED);
  });

  it("a connection that cannot be acquired", async () => {
    const failure = new Error("connection timeout");
    const pool = { connect: () => Promise.reject(failure) };

    const error = await Effect.runPromise(Effect.flip(withTransactionEffect(pool, selectOne)));

    expect(error).toEqual(new DatabaseError({ cause: failure, message: "connection timeout" }));
  });

  it("a transaction that cannot begin", async () => {
    const { client, pool } = setup();
    const failure = new Error("begin failed");
    client.failures.set("BEGIN", failure);

    const error = await Effect.runPromise(Effect.flip(withTransactionEffect(pool, selectOne)));

    expect(error).toEqual(new DatabaseError({ cause: failure, message: "begin failed" }));
    expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual(REUSED);
  });

  it("a query that fails", async () => {
    const { client, pool } = setup();
    const failure = new Error("query failed");
    client.failures.set("SELECT 1", failure);

    const error = await Effect.runPromise(Effect.flip(withTransactionEffect(pool, selectOne)));

    expect(error).toEqual(new DatabaseError({ cause: failure, message: "query failed" }));
    expect(client.releases).toEqual(REUSED);
  });

  it("a query that fails without a message", async () => {
    const { client, pool } = setup();
    client.failures.set("SELECT 1", "boom");

    const error = await Effect.runPromise(Effect.flip(withTransactionEffect(pool, selectOne)));

    expect(error).toEqual(new DatabaseError({ cause: "boom", message: "Database query failed" }));
  });
});

describe("withAuthenticatedTransactionEffect", () => {
  const claims = { org_id: "org-test", org_role: "admin", sub: "user-test" };
  const serialized = '{"org_id":"org-test","org_role":"admin","sub":"user-test"}';

  it("tenant claims with the default timeout", async () => {
    const { client, pool } = setup();

    const result = await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, claims, selectOne),
    );

    expect(result).toEqual("done");
    expect(client.statements).toEqual(["BEGIN", CLAIMS_STATEMENT, "SELECT 1", "COMMIT"]);
    expect(client.values[1]).toEqual([serialized, "10000"]);
  });

  it("a requested statement timeout", async () => {
    const { client, pool } = setup();

    await Effect.runPromise(
      withAuthenticatedTransactionEffect(pool, claims, selectOne, { statementTimeoutMs: 250 }),
    );

    expect(client.values[1]).toEqual([serialized, "250"]);
  });

  it("claims without a subject", async () => {
    const { client, pool } = setup();

    const error = await Effect.runPromise(
      Effect.flip(withAuthenticatedTransactionEffect(pool, { sub: "" }, selectOne)),
    );

    expect(error).toEqual(
      new InvalidRequestError({ message: "authenticated database claims require sub" }),
    );
    expect(client.statements).toEqual([]);
  });

  it("a statement timeout that is not positive", async () => {
    const { client, pool } = setup();

    const error = await Effect.runPromise(
      Effect.flip(
        withAuthenticatedTransactionEffect(pool, claims, selectOne, { statementTimeoutMs: 0 }),
      ),
    );

    expect(error).toEqual(
      new InvalidRequestError({ message: "statementTimeoutMs must be a positive safe integer" }),
    );
    expect(client.statements).toEqual([]);
  });
});

const binding = { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_a" };
const rotated = { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_b" };
const production = { ENVIRONMENT: "production" };
const settings = (pool: ReturnType<typeof createHyperdrivePool>) => {
  const { connectionString, connectionTimeoutMillis, idleTimeoutMillis, max, maxUses } =
    pool.options;
  return { connectionString, connectionTimeoutMillis, idleTimeoutMillis, max, maxUses };
};
const defaults = {
  connectionString: binding.connectionString,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10,
  maxUses: Number.POSITIVE_INFINITY,
};

describe("createHyperdrivePool", () => {
  it("a binding with the default limits", () => {
    expect(settings(createHyperdrivePool(binding))).toEqual(defaults);
  });

  it("every limit overridden", () => {
    const options = {
      connectionTimeoutMillis: 1,
      idleTimeoutMillis: 2,
      max: 3,
      maxUses: 4,
    };

    expect(settings(createHyperdrivePool(binding, options))).toEqual({ ...defaults, ...options });
  });

  it("a blank connection string", () => {
    expect(() => createHyperdrivePool({ connectionString: "  " })).toThrow(
      new TypeError("Hyperdrive connectionString is required"),
    );
  });
});

describe("createHyperdrivePoolCache", () => {
  it("no binding", () => {
    const resolve = createHyperdrivePoolCache("system");

    expect(() => resolve(undefined, production)).toThrow(
      new Error("system Hyperdrive binding is unavailable"),
    );
  });

  it("the same connection string twice", () => {
    const resolve = createHyperdrivePoolCache("system");

    const first = resolve(binding, production);

    expect(resolve(binding, production)).toBe(first);
  });

  it("a rotated connection string", () => {
    const resolve = createHyperdrivePoolCache("system");
    resolve(binding, production);

    const pool = resolve(rotated, production);

    expect(settings(pool)).toEqual({ ...defaults, connectionString: rotated.connectionString });
  });

  it.each([
    ["a local run", { ENVIRONMENT: "local" }],
    ["request pool mode", { ENVIRONMENT: "production", DATABASE_POOL_MODE: "request" }],
  ])("%s", (_example, env) => {
    const resolve = createHyperdrivePoolCache("system");
    const first = resolve(binding, env);

    const second = resolve(binding, env);

    expect(second).not.toBe(first);
    expect(settings(second)).toEqual({ ...defaults, maxUses: 1 });
  });

  it("a request-owned pool beside the cached one", () => {
    const resolve = createHyperdrivePoolCache("system");
    const cached = resolve(binding, production);

    resolve(binding, { ENVIRONMENT: "local" });

    expect(resolve(binding, production)).toBe(cached);
  });
});
