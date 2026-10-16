import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { DatabaseError, InvalidRequestError } from "@meltiply/domain";

import {
  acquireClient,
  DatabaseService,
  createDatabaseServiceLive,
  createDatabaseServiceTest,
  serializeAuthenticatedClaims,
  withAuthenticatedTransactionEffect,
  withTransactionEffect,
  type TransactionClient,
} from "../src";

class FakeClient implements TransactionClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  released = false;
  destroyed = false;
  failRollback = false;
  failQuery = false;
  failCommit = false;

  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    if (text === "ROLLBACK" && this.failRollback) throw new Error("rollback failed");
    if (text === "COMMIT" && this.failCommit) throw new Error("commit failed");
    if (this.failQuery && text !== "BEGIN" && text !== "COMMIT" && text !== "ROLLBACK")
      throw new Error("query failed");
    return { rows: [] as Row[] } as never;
  }

  release(destroy = false) {
    if (destroy) {
      this.destroyed = true;
      return;
    }
    this.released = true;
  }
}

describe("database transactions", () => {
  it("serializes Better Auth personal session claims with UUID subject", () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    expect(serializeAuthenticatedClaims({ sub: userId })).toBe(JSON.stringify({ sub: userId }));
  });

  it("serializes Better Auth team workspace session claims with organization UUID and role", () => {
    const userId = "10000000-0000-4000-8000-000000000001";
    const orgId = "20000000-0000-4000-8000-000000000001";
    expect(
      serializeAuthenticatedClaims({
        org_id: orgId,
        org_role: "admin",
        sub: userId,
      }),
    ).toBe(
      JSON.stringify({
        org_id: orgId,
        org_role: "admin",
        sub: userId,
      }),
    );
  });

  it("serializes a personal session without an organization claim", () => {
    expect(serializeAuthenticatedClaims({ sub: "user-alpha" })).toBe(
      JSON.stringify({ sub: "user-alpha" }),
    );
  });

  it("rejects claims without a subject", () => {
    expect(() => serializeAuthenticatedClaims({ sub: "" })).toThrow("require sub");
  });
});

describe("Effect database transactions and DatabaseService", () => {
  it("withTransactionEffect executes queries and commits on success", async () => {
    const client = new FakeClient();
    const result = await Effect.runPromise(
      withTransactionEffect({ connect: async () => client }, (tx) =>
        tx.query("SELECT 1").pipe(Effect.map(() => "success")),
      ),
    );

    expect(result).toBe("success");
    expect(client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT 1", values: undefined },
      { text: "COMMIT", values: undefined },
    ]);
    expect(client.released).toBe(true);
    expect(client.destroyed).toBe(false);
  });

  it("withTransactionEffect rolls back and preserves error on failure", async () => {
    const client = new FakeClient();
    const failureExit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => client }, (tx) =>
        tx.query("SELECT 1").pipe(Effect.flatMap(() => Effect.fail(new Error("operation error")))),
      ),
    );

    expect(failureExit._tag).toBe("Failure");
    expect(client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT 1", values: undefined },
      { text: "ROLLBACK", values: undefined },
    ]);
    expect(client.released).toBe(true);
    expect(client.destroyed).toBe(false);
  });

  it("withTransactionEffect destroys client when rollback fails", async () => {
    const client = new FakeClient();
    client.failRollback = true;

    const failureExit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => client }, () =>
        Effect.fail(new Error("app error")),
      ),
    );

    expect(failureExit._tag).toBe("Failure");
    expect(client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "ROLLBACK", values: undefined },
    ]);
    expect(client.released).toBe(false);
    expect(client.destroyed).toBe(true);
  });

  it("withTransactionEffect rolls back and destroys client when commit fails", async () => {
    const client = new FakeClient();
    client.failCommit = true;

    const failureExit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => client }, (tx) => tx.query("SELECT 1")),
    );

    expect(failureExit._tag).toBe("Failure");
    expect(client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT 1", values: undefined },
      { text: "COMMIT", values: undefined },
      { text: "ROLLBACK", values: undefined },
    ]);
    expect(client.released).toBe(false);
    expect(client.destroyed).toBe(true);
  });

  it("withTransactionEffect fails with DatabaseError on connect failure", async () => {
    const failureExit = await Effect.runPromiseExit(
      withTransactionEffect(
        {
          connect: async () => {
            throw new Error("connection timeout");
          },
        },
        (tx) => tx.query("SELECT 1"),
      ),
    );

    expect(failureExit._tag).toBe("Failure");
    if (failureExit._tag === "Failure") {
      expect(failureExit.cause.toString()).toContain("DatabaseError");
    }
  });

  it("withAuthenticatedTransactionEffect applies RLS claims and statement_timeout", async () => {
    const client = new FakeClient();
    const result = await Effect.runPromise(
      withAuthenticatedTransactionEffect(
        { connect: async () => client },
        { org_id: "org-test", org_role: "admin", sub: "user-test" },
        (tx) => tx.query("SELECT 1").pipe(Effect.map(() => "authed")),
      ),
    );

    expect(result).toBe("authed");
    expect(client.calls).toEqual([
      { text: "BEGIN", values: undefined },
      {
        text: "SELECT set_config('request.jwt.claims', $1, true), set_config('statement_timeout', '10000', true)",
        values: [
          JSON.stringify({
            org_id: "org-test",
            org_role: "admin",
            sub: "user-test",
          }),
        ],
      },
      { text: "SELECT 1", values: undefined },
      { text: "COMMIT", values: undefined },
    ]);
  });

  it("withAuthenticatedTransactionEffect fails with InvalidRequestError on invalid claims", async () => {
    const client = new FakeClient();
    const error = await Effect.runPromise(
      Effect.flip(
        withAuthenticatedTransactionEffect({ connect: async () => client }, { sub: "" }, (tx) =>
          tx.query("SELECT 1"),
        ),
      ),
    );

    expect(error).toBeInstanceOf(InvalidRequestError);
  });

  it("acquireClient provides scoped client connection released on scope exit", async () => {
    const client = new FakeClient();
    const program = Effect.scoped(
      acquireClient({ connect: async () => client }).pipe(
        Effect.flatMap((conn) => conn.query("SELECT 42")),
      ),
    );

    await Effect.runPromise(program);
    expect(client.calls).toEqual([{ text: "SELECT 42", values: undefined }]);
    expect(client.released).toBe(true);
  });

  it("DatabaseService live layer works with pool", async () => {
    const client = new FakeClient();
    const liveLayer = createDatabaseServiceLive({
      connect: async () => client,
    });

    const program = Effect.gen(function* () {
      const db = yield* DatabaseService;
      const txRes = yield* db.withTransaction((tx) =>
        tx.query("SELECT 1").pipe(Effect.map(() => "tx-ok")),
      );
      const authRes = yield* db.withAuthenticatedTransaction(
        { org_id: "org-1", sub: "u-1" },
        (tx) => tx.query("SELECT 2").pipe(Effect.map(() => "auth-ok")),
      );
      const scopedRes = yield* Effect.scoped(
        db
          .acquireClient()
          .pipe(
            Effect.flatMap((conn) => conn.query("SELECT 3").pipe(Effect.map(() => "scoped-ok"))),
          ),
      );
      return { authRes, scopedRes, txRes };
    }).pipe(Effect.provide(liveLayer));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      authRes: "auth-ok",
      scopedRes: "scoped-ok",
      txRes: "tx-ok",
    });
  });

  it("DatabaseService live layer fails closed on invalid HyperdriveBinding", async () => {
    const invalidLayer = createDatabaseServiceLive({
      connectionString: "",
    });

    const txExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        return yield* db.withTransaction((tx) => tx.query("SELECT 1"));
      }).pipe(Effect.provide(invalidLayer)),
    );
    expect(txExit._tag).toBe("Failure");

    const authExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        return yield* db.withAuthenticatedTransaction({ sub: "u1" }, (tx) => tx.query("SELECT 1"));
      }).pipe(Effect.provide(invalidLayer)),
    );
    expect(authExit._tag).toBe("Failure");

    const acquireExit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* DatabaseService;
          return yield* db.acquireClient();
        }).pipe(Effect.provide(invalidLayer)),
      ),
    );
    expect(acquireExit._tag).toBe("Failure");

    // Query failure in wrapTransactionClient
    const failClient = new FakeClient();
    failClient.failQuery = true;
    const queryExit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => failClient }, (tx) => tx.query("SELECT 1")),
    );
    expect(queryExit._tag).toBe("Failure");

    // Connection failure in acquireClient
    const acquireFailExit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireClient({
          connect: async () => {
            throw new Error("acquire connect failed");
          },
        }),
      ),
    );
    expect(acquireFailExit._tag).toBe("Failure");
  });

  it("DatabaseService test layer provides default doubles and accepts overrides", async () => {
    const defaultLayer = createDatabaseServiceTest();

    const defaultProgram = Effect.gen(function* () {
      const db = yield* DatabaseService;
      const txRes = yield* db.withTransaction((tx) =>
        tx.query("SELECT 1").pipe(Effect.map((res) => res.rows.length)),
      );
      const authRes = yield* db.withAuthenticatedTransaction({ sub: "u1" }, (tx) =>
        tx.query("SELECT 2").pipe(Effect.map((res) => res.rows.length)),
      );
      const scopedRes = yield* Effect.scoped(
        db
          .acquireClient()
          .pipe(
            Effect.flatMap((conn) =>
              conn.query("SELECT 3").pipe(Effect.map((res) => res.rows.length)),
            ),
          ),
      );
      return { authRes, scopedRes, txRes };
    }).pipe(Effect.provide(defaultLayer));

    const defaultResult = await Effect.runPromise(defaultProgram);
    expect(defaultResult).toEqual({
      authRes: 0,
      scopedRes: 0,
      txRes: 0,
    });

    const overriddenLayer = createDatabaseServiceTest({
      withTransaction: () => Effect.fail(new DatabaseError({ message: "custom db error" })),
    });

    const customExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        return yield* db.withTransaction((tx) => tx.query("SELECT 1"));
      }).pipe(Effect.provide(overriddenLayer)),
    );

    expect(customExit._tag).toBe("Failure");
    if (customExit._tag === "Failure") {
      expect(customExit.cause.toString()).toContain("custom db error");
    }
  });
});
