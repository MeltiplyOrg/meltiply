import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "../../../frontend/app/node_modules/@playwright/test/index.mjs";

/** Summarizes observed HTTP latency in milliseconds with nearest-rank p95, without extrapolating savings. */
function latency(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    count: ordered.length,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
  };
}

/**
 * Exercises built APIs and the real browser query consumers using disposable persisted fixtures.
 * `query` is a privileged, parameterized test-only PostgreSQL connection; authentication remains
 * the deployment's real cookie/token path. Requires pg_stat_statements on the disposable database.
 * Never publishes content or logs cookies/tokens. Writes credential-free observations under artifacts.
 */
export async function cacheSmoke({ origin, frontendOrigin = origin, cookie, query, label }) {
  const minted = await fetch(`${origin}/api/auth/token`, { headers: { cookie, origin: frontendOrigin } });
  assert.equal(minted.status, 200);
  const { token } = await minted.json();
  assert.equal(typeof token, "string");
  const headers = { authorization: `Bearer ${token}`, origin: frontendOrigin, "content-type": "application/json" };
  const requestIds = new Set();
  /** Performs a bounded authenticated call, preserving each response's correlation identity. */
  async function api(path, body) {
    const started = performance.now();
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
    return { data, ms: performance.now() - started };
  }
  const { data: profile } = await api("/brand-profiles", { name: `Cache smoke ${label}`, color: "#1d4ed8" });
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
        `SELECT COALESCE(sum(calls), 0)::int AS calls, COALESCE(sum(total_exec_time), 0)::float8 AS database_ms
         FROM pg_stat_statements WHERE query LIKE '%WITH candidates AS (%' AND query LIKE '%analytics_snapshots%'`,
      );
      return stats.rows[0];
    }
    const observations = [];
    /** Measures one fixed-data workload; resetting SQL stats and priming never enter the latency samples. */
    async function measure(name, paths, concurrent) {
      const before = await aggregateStats();
      const samples = concurrent
        ? await Promise.all(paths.map((path) => api(path)))
        : await paths.reduce(async (pending, path) => [...await pending, await api(path)], Promise.resolve([]));
      const after = await aggregateStats();
      for (const sample of samples) {
        assert.equal(sample.data.totals.views, 1280);
        assert.equal(sample.data.totals.post_count, 128);
        assert.equal(sample.data.last_synced_at, "2026-01-16T12:00:00.000Z");
      }
      const observation = {
        workload: name, api_requests: samples.length,
        aggregate_executions: after.calls - before.calls,
        database_ms: after.database_ms - before.database_ms,
        latency_ms: latency(samples.map((sample) => sample.ms)),
        response_bytes: Buffer.byteLength(JSON.stringify(samples[0].data)),
      };
      observations.push(observation);
      return observation;
    }
    const coldPaths = Array.from({ length: 20 }, (_, index) => `${base}${encodeURIComponent(`2026-02-01T00:00:00.${String(index).padStart(3, "0")}Z`)}`);
    const cold = await measure("cold-distinct-exact-ranges", coldPaths, false);
    assert.equal(cold.aggregate_executions, 20);
    const warmPath = `${base}2026-02-02T00%3A00%3A00Z`;
    await api(warmPath);
    const warm = await measure("warm-identical", Array(20).fill(warmPath), false);
    assert.equal(warm.aggregate_executions, 0);
    await measure("concurrent-cold-identical", Array(20).fill(`${base}2026-02-03T00%3A00%3A00Z`), true);
    // Persisted lifecycle changes bypass any local invalidation: a second DB client writes directly.
    await query("UPDATE brand_profiles SET deleted_at = now(), updated_at = now() WHERE id = $1", [profile.id]);
    assert.equal((await api(warmPath)).data.totals.post_count, 0);
    await query("UPDATE brand_profiles SET deleted_at = NULL, updated_at = now() WHERE id = $1", [profile.id]);
    assert.equal((await api(warmPath)).data.totals.views, 1280);
    // More than 64 meaningful identities: oldest completed entry must be eligible for recomputation.
    const overflow = Array.from({ length: 65 }, (_, index) => `${base}${encodeURIComponent(`2026-03-01T00:00:00.${String(index).padStart(3, "0")}Z`)}`);
    await measure("capacity-distinct-ranges", overflow, false);
    const evicted = await measure("evicted-oldest-range", [coldPaths[0]], false);
    assert.equal(evicted.aggregate_executions, 1);
    await mkdir("artifacts/cache", { recursive: true });
    await capabilityNavigation({ origin: frontendOrigin, cookie, label });
    const evidence = {
      runtime: label, dataset: { distributions: 128, snapshots: 128 }, observations,
      lifecycle: "warm explicit profile removed and restored through independent persisted writes",
      memory: { retained_serialized_payload_upper_bound_bytes: 64 * 16 * 1024, measured_heap_bytes: null,
        limitation: "Bound is contractual; workerd retained-cache heap is not externally observable in this harness." },
      limitations: ["Synthetic fixed dataset; not production savings.", "Managed local workerd is not a deployed Cloudflare isolate.", "Provider controlled-upstream acceptance runs separately; no live Provider publishing."],
    };
    await writeFile(`artifacts/cache/${label}.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    await query("DELETE FROM analytics_snapshots WHERE distribution_id IN (SELECT id FROM distributions WHERE post_id = $1)", [postId]);
    await query("DELETE FROM distributions WHERE post_id = $1", [postId]);
    await query("DELETE FROM posts WHERE id = $1", [postId]);
    await query("DELETE FROM brand_profiles WHERE id = $1", [profile.id]);
  }
}

/** Observes retained capabilities across real SPA navigation, focus/reconnect and a fresh document in both palettes/sizes. */
async function capabilityNavigation({ origin, cookie, label }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookie.split("; ").map((pair) => {
      const split = pair.indexOf("=");
      return { name: pair.slice(0, split), value: pair.slice(split + 1), url: origin };
    }));
    const page = await context.newPage();
    let reads = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/platforms/capabilities") reads++;
    });
    await page.goto(`${origin}/posts`);
    await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(1);
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Channels", exact: true }).click();
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    for (const dark of [false, true]) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate((enabled) => document.documentElement.classList.toggle("dark", enabled), dark);
        await page.screenshot({ path: `artifacts/cache/${label}-${dark ? "dark" : "light"}-${width}.png`, fullPage: true });
      }
    }
    assert.equal(reads, 1, "SPA navigation/focus/reconnect must retain successful capabilities");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Channels", exact: true })).toBeVisible();
    await expect.poll(() => reads).toBe(2);
    await context.close();
  } finally {
    await browser.close();
  }
}
