import { Client } from "pg";

/**
 * Installation-state fixture for the first-run journey, run in a short-lived
 * child process so no PostgreSQL handle outlives the Playwright worker.
 *
 * Usage: onboarding-db.mjs CONNECTION_STRING resume|complete
 *
 * `resume` marks the seeded shared Workspace's Owner as resuming optional
 * onboarding and clears the stored reporting facts, so the wizard renders and
 * both categories start off. `complete` finishes onboarding without touching the
 * Workspace name, restoring the ordinary workspace for later journeys.
 */
const [connectionString, action] = process.argv.slice(2);
if (!connectionString || !action) {
  throw new Error("usage: onboarding-db.mjs CONNECTION_STRING resume|complete");
}

const client = new Client({ connectionString });
await client.connect();
try {
  if (action === "resume") {
    await client.query(
      `INSERT INTO installation_onboarding (org_id, workspace_name, workspace_named)
       SELECT o.id, o.name, TRUE FROM organizations o WHERE o.is_shared
       ON CONFLICT (org_id) DO UPDATE
         SET completed_at = NULL, workspace_named = TRUE, updated_at = now()`,
    );
    await client.query("DELETE FROM reporting_pending_reports");
    await client.query("DELETE FROM reporting_attribution_responses");
    await client.query("DELETE FROM reporting_preferences");
  } else if (action === "complete") {
    await client.query(
      `UPDATE installation_onboarding SET completed_at = now(), updated_at = now()
       WHERE org_id IN (SELECT id FROM organizations WHERE is_shared)`,
    );
  } else {
    throw new Error(`unknown action: ${action}`);
  }
} finally {
  await client.end();
}
