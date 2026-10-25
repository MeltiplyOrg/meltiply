import { createBetterAuth, type BetterAuthInstance } from "@meltiply/auth";
import { requiresEmailVerification, type ApiWorkerEnv } from "./env";
import { sha256Hex } from "./crypto";
import { allowedOriginsFor } from "./verifier-cache";
import { createCloudflareMailSender, mailSenderConfiguration } from "./mail";
import { authPolicyHandler } from "./auth-policy";

// Auth captures a database adapter, so it may be reused only within the same
// invocation-owned bindings object, never by configuration across invocations.
const invocationAuth = new WeakMap<ApiWorkerEnv, BetterAuthInstance>();

/**
 * Outcome of a single auth rate-limit check: `ok` admits the request, `limited`
 * rejects it with the seconds the caller should wait before retrying.
 */
export interface AuthRateLimitResult {
  retryAfterSeconds?: number;
  status: "limited" | "ok";
}

/** Row shape returned by `public.auth_rate_limit_hit`. */
interface RateLimitHitRow extends Record<string, unknown> {
  retry_after: number | null;
}

/**
 * Returns Better Auth for this invocation. An auth instance captures its
 * database adapter and mail bindings, so reuse is keyed by the invocation's
 * bindings object rather than global configuration strings. Worker entries
 * clone those bindings before dispatch; weak keys release completed scopes.
 *
 * Email verification is an explicit policy, not an accident of configuration:
 * deployed environments (`staging`/`preview`) always require a verified email,
 * while `local`/`test` keep the historical default of allowing unverified
 * sign-in. When verification is required, a usable `MAIL` binding plus a valid
 * `MAIL_FROM_ADDRESS` sender must also exist — a missing or malformed mail
 * configuration fails closed at resolution instead of silently disabling
 * verification. In local/test the sender is wired whenever it is usable so the
 * simulated binding still emits verification/recovery messages.
 *
 * @param env - Worker environment bindings containing database connection and auth configuration.
 * @returns Configured Better Auth instance.
 * @throws {Error} When `BETTER_AUTH_SECRET` is absent outside local/test, or when
 *   verification is required but the mail binding or sender configuration is unusable.
 */
export async function betterAuthFor(env: ApiWorkerEnv): Promise<BetterAuthInstance> {
  const isLocalOrTest = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
  const cached = invocationAuth.get(env);
  if (cached) return cached;
  const secret =
    env.BETTER_AUTH_SECRET?.trim() ||
    (isLocalOrTest ? "meltiply-local-auth-secret-32-chars-long" : undefined);

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET must be configured in staging and production");
  }
  const baseURL =
    env.BETTER_AUTH_URL?.trim() ||
    (env.PUBLIC_API_URL?.trim() ? env.PUBLIC_API_URL.trim() : undefined);
  const requireEmailVerification = requiresEmailVerification(env);
  const senderAddress = mailSenderConfiguration(env);
  const mailUsable =
    senderAddress !== undefined && env.MAIL !== undefined && typeof env.MAIL.send === "function";

  if (requireEmailVerification && !mailUsable) {
    throw new Error(
      "MAIL binding and MAIL_FROM_ADDRESS must be usable when email verification is required",
    );
  }

  const trustedOrigins = Array.from(allowedOriginsFor(env));
  // Exception: dynamic import avoids loading pg in workerd unit test isolates
  const { systemPoolFor } = await import("./database");
  const database = systemPoolFor(env);
  const auth = authPolicyHandler(
    env,
    await createBetterAuth({
      baseURL,
      database,
      isAccountActive: async (userId: string) => {
        const result = await database.query<{ suspended_at: Date | string | null }>(
          `SELECT suspended_at FROM users WHERE auth_user_id = $1 LIMIT 1`,
          [userId],
        );
        return result.rows[0]?.suspended_at === null || result.rows[0] === undefined;
      },
      ...(mailUsable
        ? {
            email: {
              send: createCloudflareMailSender(env.MAIL, senderAddress).send,
            },
          }
        : {}),
      requireEmailVerification,
      secret,
      trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
    }),
  );

  invocationAuth.set(env, auth);

  return auth;
}

/**
 * Fixed-window abuse-control policy for a single Better Auth action.
 * `maxAttempts` requests per `windowSeconds` are allowed per identity bucket.
 */
interface AuthRateLimitRule {
  maxAttempts: number;
  windowSeconds: number;
}

/**
 * Per-action auth rate limits. Email-bearing actions are keyed by the normalized
 * email and by caller IP; all other auth endpoints share a per-IP budget.
 */
const AUTH_RATE_LIMITS: Record<string, AuthRateLimitRule> = {
  generic: { maxAttempts: 120, windowSeconds: 60 },
  "request-password-reset": { maxAttempts: 5, windowSeconds: 3600 },
  "reset-password": { maxAttempts: 10, windowSeconds: 600 },
  "send-verification-email": { maxAttempts: 5, windowSeconds: 3600 },
  "sign-in": { maxAttempts: 10, windowSeconds: 600 },
  "sign-up": { maxAttempts: 5, windowSeconds: 3600 },
  "invitation-accept": { maxAttempts: 10, windowSeconds: 600 },
  "two-factor": { maxAttempts: 10, windowSeconds: 600 },
  "change-password": { maxAttempts: 10, windowSeconds: 600 },
};

const EMAIL_RATE_LIMIT_ACTIONS = new Set([
  "request-password-reset",
  "send-verification-email",
  "sign-in",
  "sign-up",
]);

/**
 * Atomically records one attempt against a fixed-window bucket and reports rejection.
 *
 * Calls `public.auth_rate_limit_hit(action, subject, window_seconds, max_attempts)`
 * on the system pool. The INSERT ... ON CONFLICT increment is atomic under
 * concurrency, so the returned denial is authoritative across Worker isolates.
 *
 * @param env - Worker environment bindings.
 * @param subject - Normalized subject (`email:<addr>` or `ip:<addr>`).
 * @param rule - Window size and attempt ceiling for the action.
 * @param action - Rate-limit action key stored in `auth_rate_limits.action`.
 * @returns Null when the attempt is allowed, or Retry-After seconds when denied.
 */
async function authRateLimitHit(
  env: ApiWorkerEnv,
  action: string,
  subject: string,
  rule: AuthRateLimitRule,
): Promise<number | null> {
  // Exception: dynamic import avoids loading pg in workerd unit test isolates
  const { systemPoolFor } = await import("./database");
  const client = await systemPoolFor(env).connect();
  try {
    const result = await client.query<RateLimitHitRow>(
      `SELECT public.auth_rate_limit_hit($1, $2, $3, $4) AS retry_after`,
      [action, subject, rule.windowSeconds, rule.maxAttempts],
    );
    const retryAfter = result.rows[0]?.retry_after;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : null;
  } finally {
    client.release();
  }
}

/**
 * Extracts only the edge-authenticated client IP. The self-hosted ingress strips
 * forwarding headers and writes its socket address; arbitrary X-Forwarded-For
 * is never trusted. Missing IPs deliberately share a conservative bucket.
 */
function clientIp(request: Request): string | undefined {
  const connecting = request.headers.get("cf-connecting-ip")?.trim();
  if (connecting) return connecting;
  return undefined;
}

/**
 * Reads the normalized email from a JSON auth request body without consuming it.
 *
 * Clones the request before parsing so the downstream Better Auth handler still
 * receives the original body stream.
 *
 * @param request - Incoming auth request.
 * @returns Lowercased trimmed email, or undefined when absent or unparseable.
 */
async function requestEmail(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === "object" && "email" in body) {
      const email = body.email;
      if (typeof email === "string" && email.trim()) {
        return email.trim().toLowerCase();
      }
    }
  } catch {
    // Non-JSON or missing bodies simply have no email identity.
  }
  return undefined;
}

/**
 * Enforces the database-backed fixed-window rate limit for one Better Auth request.
 *
 * Records attempts through `public.auth_rate_limit_hit()` keyed by action plus a
 * SHA-256 subject (`email:<hash>` for credential endpoints and always `ip:<hash>`),
 * so limits are distributed across isolates and cannot be bypassed by rotating
 * either identity dimension. Fails closed: a rate-limit store error propagates
 * as a 500 rather than allowing unbounded abuse.
 *
 * @param env - Worker environment bindings.
 * @param action - Rate-limit action key (e.g. `"sign-in"`, `"generic"`).
 * @param request - Incoming auth request.
 * @returns `"ok"` when within budget, or `"limited"` with a Retry-After hint.
 */
export async function checkAuthRateLimit(
  env: ApiWorkerEnv,
  action: string,
  request: Request,
): Promise<AuthRateLimitResult> {
  const rule = AUTH_RATE_LIMITS[action] ?? AUTH_RATE_LIMITS.generic!;
  const subjects: string[] = [];
  if (EMAIL_RATE_LIMIT_ACTIONS.has(action)) {
    const email = await requestEmail(request);
    if (email) {
      subjects.push(`email:${await sha256Hex(email)}`);
    }
  }
  const ip = clientIp(request);
  subjects.push(`ip:${await sha256Hex(ip ?? "unknown")}`);
  for (const subject of subjects) {
    const retryAfterSeconds = await authRateLimitHit(env, action, subject, rule);
    if (retryAfterSeconds !== null) {
      return { retryAfterSeconds, status: "limited" };
    }
  }
  return { status: "ok" };
}
