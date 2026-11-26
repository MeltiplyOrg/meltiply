import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect } from "effect";
import { DatabaseError, InvalidRequestError } from "@meltiply/domain";

import {
  createHyperdrivePoolCache,
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
    return { command: "SELECT", fields: [], oid: 0, rowCount: 0, rows: [] as Row[] };
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

describe("Effect database transactions", () => {
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
    const operationError = new Error("operation error");
    const failureExit = await Effect.runPromiseExit(
      withTransactionEffect({ connect: async () => client }, (tx) =>
        tx.query("SELECT 1").pipe(Effect.flatMap(() => Effect.fail(operationError))),
      ),
    );

    expect(failureExit._tag).toBe("Failure");
    if (failureExit._tag === "Failure") {
      expect(Cause.squash(failureExit.cause)).toBe(operationError);
    }
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
        text: "SELECT set_config('request.jwt.claims', $1, true), set_config('statement_timeout', $2, true)",
        values: [
          JSON.stringify({
            org_id: "org-test",
            org_role: "admin",
            sub: "user-test",
          }),
          "10000",
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

  it("withTransactionEffect maps query failures to DatabaseError and keeps the client reusable", async () => {
    const client = new FakeClient();
    client.failQuery = true;
    const error = await Effect.runPromise(
      Effect.flip(
        withTransactionEffect({ connect: async () => client }, (tx) => tx.query("SELECT 1")),
      ),
    );
    expect(error).toBeInstanceOf(DatabaseError);
    expect(client.released).toBe(true);
    expect(client.destroyed).toBe(false);
  });

  it("caches Hyperdrive pools per connection string and isolates request-owned pools", async () => {
    const resolvePool = createHyperdrivePoolCache("system");
    expect(() => resolvePool(undefined, { ENVIRONMENT: "production" })).toThrow(
      "system Hyperdrive binding is unavailable",
    );

    const primary = resolvePool(
      { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_a" },
      { ENVIRONMENT: "production" },
    );
    const samePrimary = resolvePool(
      { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_a" },
      { ENVIRONMENT: "production" },
    );
    expect(samePrimary).toBe(primary);

    const requestOwned = resolvePool(
      { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_a" },
      { ENVIRONMENT: "local" },
    );
    expect(requestOwned).not.toBe(primary);
    expect(
      resolvePool(
        { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_a" },
        { ENVIRONMENT: "production" },
      ),
    ).toBe(primary);

    const rotated = resolvePool(
      { connectionString: "postgres://user:pass@127.0.0.1:5432/meltiply_b" },
      { ENVIRONMENT: "production" },
    );
    expect(rotated).not.toBe(primary);

    await Promise.all([primary.end(), requestOwned.end(), rotated.end()]);
  });

  it("rejects non-positive statementTimeoutMs in withAuthenticatedTransactionEffect", async () => {
    const client = new FakeClient();
    const error = await Effect.runPromise(
      Effect.flip(
        withAuthenticatedTransactionEffect(
          { connect: async () => client },
          { sub: "user-1" },
          (tx) => tx.query("SELECT 1"),
          { statementTimeoutMs: 0 },
        ),
      ),
    );
    expect(error).toBeInstanceOf(InvalidRequestError);
  });
});
