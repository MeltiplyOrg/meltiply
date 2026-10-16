import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));
vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { saveOAuthConnectionEffect } from "../src/oauth-connection";
import type { ApiWorkerEnv } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";

const primaryKey = "0123456789abcdef0123456789abcdef";
const rotatedKey = "abcdef0123456789abcdef0123456789";

function envWithKey(key?: string): ApiWorkerEnv {
  return { TOKEN_ENCRYPTION_KEY: key } as ApiWorkerEnv;
}

describe("API token credentials", () => {
  it("reuses the cipher until the token key binding changes", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(primaryKey))).toBe(first);
    expect(tokenCipherFor(envWithKey(rotatedKey))).not.toBe(first);
  });

  it("fails closed when token encryption is unavailable", () => {
    try {
      tokenCipherFor(envWithKey());
      throw new Error("expected token cipher construction to fail");
    } catch (cause) {
      expect(cause).toMatchObject({
        code: "service_unavailable",
        status: 503,
      });
    }
  });
});

describe("OAuth connection token refresh arming", () => {
  const owner = {
    brandProfileId: "00000000-0000-4000-8000-000000000111",
    organizationId: "00000000-0000-4000-8000-000000000001",
    userId: "user-1",
  };
  const connection = {
    accessToken: "provider-access-token",
    account: { displayName: "Creator", id: "provider-account" },
    expiresAt: "2027-01-01T00:00:00.000Z",
    refreshToken: "provider-refresh-token",
    scopes: ["publish"],
  };

  /**
   * Fake transaction client recording queries and answering the fixed
   * organization, membership, active-profile, lock, and existing-account
   * lookups the persistence path issues before the platform_accounts upsert.
   */
  function clientReturning(queries: Array<{ sql: string; params?: unknown[] }>) {
    return {
      query: vi.fn((sql: string, params?: unknown[]) => {
        queries.push({ params, sql });
        if (sql.includes("FROM organizations")) {
          return Effect.succeed({
            rows: [
              {
                id: owner.organizationId,
              },
            ],
            rowCount: 1,
          });
        }
        if (sql.includes("FROM org_members")) {
          return Effect.succeed({ rows: [{ role: "admin" }], rowCount: 1 });
        }
        if (sql.includes("FROM brand_profiles")) {
          return Effect.succeed({
            rows: [{ deleted_at: null }],
            rowCount: 1,
          });
        }
        if (sql.includes("FROM platform_accounts")) {
          return Effect.succeed({ rows: [], rowCount: 0 });
        }
        if (sql.includes("INSERT INTO platform_accounts")) {
          return Effect.succeed({ rows: [{ id: "account-1" }], rowCount: 1 });
        }
        return Effect.succeed({ rows: [], rowCount: 0 });
      }),
    };
  }

  // The persisted schedule remains the final bound parameter after Brand
  // Profile ownership and the connecting user are recorded in the upsert.
  it("arms token_refresh_next_attempt_at when the grant carries an expiry", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(clientReturning(queries)),
    );

    await Effect.runPromise(
      saveOAuthConnectionEffect(envWithKey(primaryKey), "threads", owner, connection),
    );

    const upsert = queries.find(({ sql }) => sql.includes("INSERT INTO platform_accounts"));
    expect(upsert?.sql).toContain("token_refresh_next_attempt_at");
    expect(upsert?.sql).toContain(
      "token_refresh_next_attempt_at = EXCLUDED.token_refresh_next_attempt_at",
    );
    const armed = upsert?.params?.[11];
    expect(armed).toBeInstanceOf(Date);
    // max(now + 1h, expiresAt - 7d): the 2027 expiry resolves to expiry - 7d.
    expect((armed as Date).toISOString()).toBe("2026-12-25T00:00:00.000Z");
    expect(upsert?.params?.[6]).toMatch(/^meltiply:v2:primary:/);
  });

  // An expiry-free grant still writes the same profile-scoped upsert shape,
  // with its final refresh-schedule parameter deliberately null.
  it("leaves the refresh schedule unarmed when the grant has no expiry", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(clientReturning(queries)),
    );

    await Effect.runPromise(
      saveOAuthConnectionEffect(envWithKey(primaryKey), "threads", owner, {
        ...connection,
        expiresAt: undefined,
      }),
    );

    const upsert = queries.find(({ sql }) => sql.includes("INSERT INTO platform_accounts"));
    expect(upsert?.params?.[11]).toBeNull();
  });
});
