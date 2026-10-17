import type { BetterAuthInstance, JwtIdentity } from "@meltiply/auth";
import { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";

/** Reads only the installation's public initialized bit; never returns owner details. */
export async function installationInitialized(env: ApiWorkerEnv): Promise<boolean> {
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const result = await systemPoolFor(env).query<{ initialized: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "user" WHERE "installationOwner") AS initialized`,
  );
  return result.rows[0]?.initialized === true;
}

/**
 * Guards first registration with a deployment secret and bounded profile input.
 * PostgreSQL's unique owner index arbitrates races; UI state is never authority.
 * Unknown mutation fields remain Better Auth's responsibility. Secrets are not logged.
 */
export function ownerAuthHandler(env: ApiWorkerEnv, auth: BetterAuthInstance): BetterAuthInstance {
  return {
    handler: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/setup-status" && request.method === "GET") {
        const initialized = await installationInitialized(env);
        if (!initialized && (env.AUTH_SETUP_SECRET?.length ?? 0) < 32) {
          return Response.json(
            {
              message:
                "Configure AUTH_SETUP_SECRET with at least 32 random characters before initial setup.",
            },
            { status: 503, headers: { "Cache-Control": "no-store" } },
          );
        }
        return Response.json({ initialized }, { headers: { "Cache-Control": "no-store" } });
      }
      if (path === "/api/auth/sign-up/email" && request.method === "POST") {
        if (await installationInitialized(env)) {
          return Response.json(
            { message: "This installation already has an owner. Sign in instead." },
            { status: 403 },
          );
        }
        const expected = env.AUTH_SETUP_SECRET;
        if (!expected || expected.length < 32) {
          return Response.json(
            {
              message:
                "Configure AUTH_SETUP_SECRET with at least 32 random characters before initial setup.",
            },
            { status: 503 },
          );
        }
        const supplied = request.headers.get("X-Setup-Secret") ?? "";
        // Web Crypto verifies the MAC in constant time; no secret string comparison.
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(expected),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        );
        const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(supplied));
        if (!(await crypto.subtle.verify("HMAC", key, signature, encoder.encode(expected)))) {
          return Response.json({ message: "The setup secret is invalid." }, { status: 403 });
        }
      }
      if (
        request.method === "POST" &&
        (path === "/api/auth/sign-up/email" || path === "/api/auth/update-user")
      ) {
        let body: unknown;
        try {
          body = await request.clone().json();
        } catch {
          return Response.json({ message: "Expected a JSON object." }, { status: 400 });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return Response.json({ message: "Expected a JSON object." }, { status: 400 });
        }
        if (
          "name" in body &&
          (typeof body.name !== "string" ||
            !body.name.trim() ||
            body.name.length > 100 ||
            /[\x00-\x1F\x7F]/.test(body.name))
        ) {
          return Response.json(
            { message: "Name must contain 1–100 characters without control characters." },
            { status: 400 },
          );
        }
        if (
          "image" in body &&
          body.image !== null &&
          (typeof body.image !== "string" ||
            body.image.length > 2048 ||
            !URL.canParse(body.image) ||
            new URL(body.image).protocol !== "https:")
        ) {
          return Response.json(
            { message: "Profile image must be an HTTPS URL of at most 2048 characters." },
            { status: 400 },
          );
        }
      }
      return auth.handler(request);
    },
  };
}

/**
 * Resolves a JWT's live owner session before any protected work. Reads the current
 * profile rather than trusting stale JWT claims. Missing, revoked, expired, or
 * unverified deployed sessions fail closed; no cookie is accepted on this surface.
 */
export async function activeOwnerIdentity(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
): Promise<JwtIdentity> {
  if (!identity.sessionId)
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  // Exception: pg cannot be loaded in workerd unit-test isolates.
  const { systemPoolFor } = await import("./database");
  const result = await systemPoolFor(env).query<{ email: string; name: string }>(
    `SELECT u.email, u.name FROM "session" s JOIN "user" u ON u.id = s."userId"
     WHERE s.id = $1 AND u.id = $2 AND s."expiresAt" > now()
       AND u."installationOwner" AND ($3::boolean OR u."emailVerified")`,
    [
      identity.sessionId,
      identity.subject,
      env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test",
    ],
  );
  const owner = result.rows[0];
  if (!owner) throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  return { ...identity, email: owner.email, name: owner.name };
}
