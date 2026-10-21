import { Client } from "pg";

const [connectionString, action, email, tokenHash] = process.argv.slice(2);
if (!connectionString || !action || !email) {
  throw new Error("usage: invitation-db.mjs CONNECTION ACTION EMAIL [TOKEN_HASH]");
}

const client = new Client({ connectionString });
await client.connect();
try {
  if (action === "repoint") {
    if (!tokenHash) throw new Error("repoint requires a token hash");
    await client.query(
      `UPDATE workspace_invitations SET token_hash = $2 WHERE lower(email) = lower($1)`,
      [email, tokenHash],
    );
  } else if (action === "cleanup") {
    await client.query(
      `DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE lower(email) = lower($1))`,
      [email],
    );
    await client.query(
      `DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE lower(email) = lower($1))`,
      [email],
    );
    await client.query(`DELETE FROM "user" WHERE lower(email) = lower($1)`, [email]);
    await client.query(
      `DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
    await client.query(`DELETE FROM users WHERE lower(email) = lower($1)`, [email]);
    await client.query(`DELETE FROM workspace_invitations WHERE lower(email) = lower($1)`, [email]);
    await client.query(`DELETE FROM workspace_audit_entries WHERE lower(actor_email) = lower($1)`, [
      email,
    ]);
  } else {
    throw new Error(`unknown action: ${action}`);
  }
} finally {
  await client.end();
}
