import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import { systemPoolFor } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

type Schemas = components["schemas"];
const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) throw new Error("MELTIPLY_DATABASE_TEST_URL is required");

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const organizationId = "2f000000-0000-4000-8000-000000000001";
const identities: Record<string, JwtIdentity> = {
  admin: { email: "alpha@meltiply.local", emailVerified: true, subject: "auth_user_local_alpha" },
  editor: { email: "gamma@meltiply.local", emailVerified: true, subject: "auth_user_local_gamma" },
};
const members = {
  admin: { role: "admin" as const, userId: "10000000-0000-4000-8000-000000000001" },
  editor: { role: "editor" as const, userId: "10000000-0000-4000-8000-000000000003" },
};

const app = createApiApp({
  resolveActor: async (_env, identity) => {
    const member = members[identity.subject === identities.admin!.subject ? "admin" : "editor"];
    return {
      authUserId: identity.subject,
      claims: {
        organizationId,
        organizationRole: member.role,
        subject: identity.subject,
        userId: member.userId,
      },
      displayName: "Preference member",
      email: identity.email,
      isInstallationOwner: false,
      role: member.role,
      userId: member.userId,
      workspace: {
        id: organizationId,
        name: "Preference regression",
        slug: `pref-${organizationId}`,
      },
    };
  },
  verifyJwtToken: async (_env, token) => identities[token]!,
});

function request(method: string, body?: unknown, key = randomUUID(), role = "admin") {
  return app.request(
    "/api/v1/publishing-preferences",
    {
      method,
      headers: {
        Authorization: `Bearer ${role}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

const firstTemplate: Schemas["SignatureTemplate"] = {
  body: "Follow {brand_profile} on {platform}.",
  id: randomUUID(),
  is_default: true,
  name: "Launch footer",
  position: 0,
};

const secondTemplate: Schemas["SignatureTemplate"] = {
  body: "Questions? Reach {channel}.",
  id: randomUUID(),
  is_default: false,
  name: "Support footer",
  position: 1,
};

beforeAll(async () => {
  await systemPoolFor(env).query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  await systemPoolFor(env).query(
    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Preference regression', $2)",
    [organizationId, `pref-${organizationId}`],
  );
  await systemPoolFor(env).query(
    "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'editor')",
    [organizationId, members.admin.userId, members.editor.userId],
  );
});

afterAll(async () => {
  await systemPoolFor(env).query("DELETE FROM organizations WHERE id = $1", [organizationId]);
});

describe("publishing preferences HTTP", () => {
  it("persists timezone, ordered signatures, and notification choices", async () => {
    const response = await request("PUT", {
      notifications: {
        channels: { email: { enabled: false, recipients: [] } },
        events: { channel_disconnected: true, publication_failed: false },
      },
      signature_templates: [firstTemplate, secondTemplate],
      timezone: "America/New_York",
    });
    expect(response.status).toBe(200);
    const saved: Schemas["PublishingPreferences"] = await response.json();
    expect(saved.timezone).toBe("America/New_York");
    expect(saved.signature_templates.map((template) => template.name)).toEqual([
      "Launch footer",
      "Support footer",
    ]);
    expect(saved.notifications.events.channel_disconnected).toBe(true);

    const read = await request("GET");
    expect(await read.json()).toEqual(saved);
  });

  it("refuses email on an installation without mail delivery", async () => {
    const response = await request("PUT", {
      notifications: {
        channels: {
          email: {
            enabled: true,
            recipients: ["alpha@meltiply.local", "ops@meltiply.local"],
          },
        },
        events: { channel_disconnected: false, publication_failed: false },
      },
      signature_templates: [],
      timezone: null,
    });
    expect(response.status).toBe(422);
    const body: { error: { code: string } } = await response.json();
    expect(body.error.code).toBe("notification_channel_unavailable");
  });

  it("forbids an Editor from changing shared preferences", async () => {
    const response = await request(
      "PUT",
      {
        notifications: {
          channels: { email: { enabled: false, recipients: [] } },
          events: { channel_disconnected: false, publication_failed: false },
        },
        signature_templates: [],
        timezone: null,
      },
      randomUUID(),
      "editor",
    );
    expect(response.status).toBe(403);
  });

  it("replays the same replacement without writing a second result", async () => {
    const key = randomUUID();
    const body = {
      notifications: {
        channels: { email: { enabled: false, recipients: [] } },
        events: { channel_disconnected: false, publication_failed: false },
      },
      signature_templates: [firstTemplate],
      timezone: "Europe/Berlin",
    };
    const first = await request("PUT", body, key);
    const replay = await request("PUT", body, key);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
  });
});
