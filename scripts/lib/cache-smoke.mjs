import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { capabilityNavigation } from "../../frontend/app/e2e/cache-smoke.mjs";

/**
 * Exercises built APIs and the real browser query consumers using disposable persisted fixtures.
 * `query` is a privileged, parameterized test-only PostgreSQL connection; authentication remains
 * the deployment's real cookie/token path. Requires pg_stat_statements on the disposable database.
 * Never publishes content or logs cookies/tokens. SQL observations assert cache reuse,
 * not latency or resource measurements.
 */
export async function cacheSmoke({ origin, frontendOrigin = origin, cookie, query, label }) {
  const minted = await fetch(`${origin}/api/auth/token`, {
    headers: { cookie, origin: frontendOrigin },
  });
  assert.equal(minted.status, 200);
  const { token } = await minted.json();
  assert.equal(typeof token, "string");
  const headers = {
    authorization: `Bearer ${token}`,
    origin: frontendOrigin,
    "content-type": "application/json",
  };
  const requestIds = new Set();
  /** Performs a bounded authenticated call, preserving each response's correlation identity. */
  async function api(path, body) {
    const response = await fetch(`${origin}/api/v1${path}`, {
      headers: { ...headers, "idempotency-key": randomUUID() },
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, body === undefined ? 200 : 201, `${path}: ${response.status}`);
    const data = await response.json();
    const requestId = response.headers.get("x-request-id");
    assert.ok(requestId, "Every response needs correlation");
    assert.equal(requestIds.has(requestId), false, "Responses must not reuse request identities");
    requestIds.add(requestId);
    return { data };
  }
  const { data: profile } = await api("/brand-profiles", {
    name: `Cache smoke ${label}`,
    color: "#1d4ed8",
  });
  const postId = randomUUID();
  const result = await query("SELECT org_id::text FROM brand_profiles WHERE id = $1", [profile.id]);
  const workspaceId = result.rows[0].org_id;
  try {
    await query(
      `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
       VALUES ($1, $2, $3, 'Cache smoke cohort', 'Stored snapshot acceptance', 'active')`,
      [postId, workspaceId, profile.id],
    );
    await query(
      `INSERT INTO distributions (org_id, brand_profile_id, post_id, platform, status, published_at, platform_post_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'threads', 'published', '2026-01-15T12:00:00Z', 'cache-smoke-' || n
       FROM generate_series(1, 128) n`,
      [workspaceId, profile.id, postId],
    );
    await query(
      `INSERT INTO analytics_snapshots (org_id, distribution_id, views, likes, comments, shares, snapshot_at)
       SELECT org_id, id, 10, 2, 1, 0, '2026-01-16T12:00:00Z' FROM distributions WHERE post_id = $1`,
      [postId],
    );
    const base = `/analytics?brand_profile_id=${profile.id}&start=2026-01-01T00%3A00%3A00Z&end=`;
    /** Reads only aggregate executions, excluding auth/visibility work and fixture preparation. */
    async function aggregateStats() {
      const stats = await query(
        `SELECT COALESCE(sum(calls), 0)::int AS calls
         FROM pg_stat_statements WHERE query LIKE '%WITH candidates AS (%' AND query LIKE '%analytics_snapshots%'`,
      );
      return stats.rows[0];
    }
    /** Asserts persisted summaries for sequential or concurrent reads and returns the aggregate query count. */
    async function exercise(paths, concurrent, beforeSample) {
      const before = await aggregateStats();
      const samples = [];
      if (concurrent) {
        samples.push(...(await Promise.all(paths.map((path) => api(path)))));
      } else {
        for (const path of paths) {
          if (beforeSample) await beforeSample();
          samples.push(await api(path));
        }
      }
      const after = await aggregateStats();
      for (const sample of samples) {
        assert.equal(sample.data.totals.views, 1280);
        assert.equal(sample.data.totals.post_count, 128);
        assert.equal(sample.data.last_synced_at, "2026-01-16T12:00:00.000Z");
      }
      return after.calls - before.calls;
    }
    const coldPaths = Array.from(
      { length: 20 },
      (_, index) =>
        `${base}${encodeURIComponent(`2026-02-01T00:00:00.${String(index).padStart(3, "0")}Z`)}`,
    );
    const cold = await exercise(coldPaths, false);
    assert.equal(cold, 20);
    const uncached = await exercise(Array(20).fill(coldPaths[0]), false, () =>
      query("UPDATE brand_profiles SET updated_at = clock_timestamp() WHERE id = $1", [profile.id]),
    );
    assert.equal(uncached, 20);
    const warmPath = `${base}2026-02-02T00%3A00%3A00Z`;
    await api(warmPath);
    const warm = await exercise(Array(20).fill(warmPath), false);
    assert.equal(warm, 0);
    await exercise(Array(20).fill(`${base}2026-02-03T00%3A00%3A00Z`), true);
    // Persisted lifecycle changes bypass any local invalidation: a second DB client writes directly.
    await query(
      "UPDATE brand_profiles SET deleted_at = now(), purge_at = now() + interval '30 days', updated_at = now() WHERE id = $1",
      [profile.id],
    );
    assert.equal((await api(warmPath)).data.totals.post_count, 0);
    await query(
      "UPDATE brand_profiles SET deleted_at = NULL, purge_at = NULL, updated_at = now() WHERE id = $1",
      [profile.id],
    );
    assert.equal((await api(warmPath)).data.totals.views, 1280);
    // More than 64 meaningful identities: oldest completed entry must be eligible for recomputation.
    const overflow = Array.from(
      { length: 65 },
      (_, index) =>
        `${base}${encodeURIComponent(`2026-03-01T00:00:00.${String(index).padStart(3, "0")}Z`)}`,
    );
    await exercise(overflow, false);
    const evicted = await exercise([coldPaths[0]], false);
    assert.equal(evicted, 1);
    const expiryPath = `${base}2026-04-01T00%3A00%3A00Z`;
    assert.equal((await api(expiryPath)).data.totals.views, 1280);
    await query(
      "UPDATE analytics_snapshots SET views = 20 WHERE distribution_id IN (SELECT id FROM distributions WHERE post_id = $1)",
      [postId],
    );
    assert.equal(
      (await api(expiryPath)).data.totals.views,
      1280,
      "Ordinary snapshot writes may remain stale only within TTL",
    );
    // Runtime smoke observes real wall-clock expiry; regression tests use controlled time instead.
    await delay(31_000);
    assert.equal((await api(expiryPath)).data.totals.views, 2560);
    await mkdir("artifacts/cache", { recursive: true });
    const removedId = randomUUID();
    const survivingId = randomUUID();
    await query(
      `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
       VALUES ($1, $3, $4, 'Progress removed smoke', 'Progress removed smoke', 'active'),
              ($2, $3, $4, 'Progress surviving smoke', 'Progress surviving smoke', 'active')`,
      [removedId, survivingId, workspaceId, profile.id],
    );
    await query(
      `INSERT INTO distributions (org_id, brand_profile_id, post_id, platform, status)
       VALUES ($1, $2, $3, 'threads', 'processing'), ($1, $2, $4, 'threads', 'processing')`,
      [workspaceId, profile.id, removedId, survivingId],
    );
    await capabilityNavigation({
      origin: frontendOrigin,
      cookie,
      label,
      progressFixture: {
        survivingId,
        async advance() {
          await query("DELETE FROM posts WHERE id = $1", [removedId]);
          await query(
            "UPDATE distributions SET status = 'published', published_at = now(), platform_post_id = 'smoke-progress', updated_at = now() WHERE post_id = $1",
            [survivingId],
          );
        },
      },
    });
    console.log(`Cache lifecycle and browser checks passed: ${label}`);
  } finally {
    await query(
      "DELETE FROM analytics_snapshots WHERE distribution_id IN (SELECT id FROM distributions WHERE post_id = $1)",
      [postId],
    );
    await query("DELETE FROM distributions WHERE post_id = $1", [postId]);
    await query("DELETE FROM posts WHERE id = $1", [postId]);
    await query("DELETE FROM brand_profiles WHERE id = $1", [profile.id]);
  }
}
