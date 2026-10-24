import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { chromium } from "../../../frontend/app/node_modules/@playwright/test/index.mjs";
import { cacheSmoke } from "./cache-smoke.mjs";

const origin = "http://127.0.0.1:8787";
const frontendOrigin = "http://127.0.0.1:3000";
const children = [];
const pool = new pg.Pool({ connectionString: "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable" });
/** Starts only owned process groups; output stays in the hosted job for diagnostics. */
function start(command, args, env = {}) {
  const child = spawn(command, args, { detached: true, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  return child;
}
/** Waits for an actual HTTP response with a fixed startup deadline, rejecting early process exits. */
async function ready(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(child.exitCode, null, `Runtime exited before ${url}`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false)) return;
    await delay(1000);
  }
  throw new Error(`Runtime did not become ready: ${url}`);
}
try {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  const backend = start("bash", ["scripts/cloudflare-local/dev-backend.sh"], {
    WRANGLER_DEV_ALLOWED_ORIGINS: frontendOrigin,
    WRANGLER_DEV_FRONTEND_URL: frontendOrigin,
    WRANGLER_DEV_PUBLIC_API_URL: origin,
  });
  await ready(`${origin}/api/v1/ready`, backend);
  const frontend = start("bun", ["run", "--cwd", "frontend/app", "--no-install", "vp", "preview", "--host", "127.0.0.1", "--port", "3000", "--strictPort"]);
  await ready(frontendOrigin, frontend);
  const browser = await chromium.launch({ headless: true });
  let cookie;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${frontendOrigin}/sign-in`);
    await page.getByLabel("Email address", { exact: true }).fill("alpha@meltiply.local");
    await page.getByLabel("Password", { exact: true }).fill("MeltiplyLocal1!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/posts/, { timeout: 30_000 });
    cookie = (await context.cookies()).map((entry) => `${entry.name}=${entry.value}`).join("; ");
  } catch {
    throw new Error("Managed-runtime owner sign-in failed; sensitive form details suppressed");
  } finally {
    await browser.close();
  }
  await cacheSmoke({ origin, frontendOrigin, cookie, query: pool.query.bind(pool), label: "managed-local-workerd" });
} finally {
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    }
  }
  await pool.end();
  await delay(2000);
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }
  }
}
