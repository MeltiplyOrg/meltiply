import { createBetterAuth, type BetterAuthInstance } from "@meltiply/auth";
import {
  DEVICE_CLIENT_ID,
  DEVICE_CODE_EXPIRES_IN,
  DEVICE_POLL_INTERVAL,
  deviceVerificationUri,
} from "./device-authorization";
import { requiresEmailVerification, type ApiWorkerEnv } from "./env";
import { sha256Hex } from "./crypto";
import { allowedOriginsFor } from "./verifier-cache";
import { createCloudflareMailSender, mailSenderConfiguration } from "./mail";
import { authPolicyHandler } from "./auth-policy";

let betterAuthCached:
  | {
      baseURL: string | undefined;
      databaseConnectionString: string | undefined;
      environment: ApiWorkerEnv["ENVIRONMENT"];
      mailBinding: SendEmail | undefined;
      mailFromAddress: string | undefined;
      mailFromName: string | undefined;
      origins: string;
      requireEmailVerification: boolean;
      secret: string;
      setupSecret: string | undefined;
      value: BetterAuthInstance;
    }
  | undefined;

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
 * Returns a cached Better Auth instance keyed by every binding it captures.
 * Local and explicitly request-owned pools are never cached because their
 * adapters belong to one invocation; managed isolates reuse the instance while
 * its secret, origins, mail configuration, policy, and database remain stable.
 *
 * Email verification is explicit: deployed environments require verified email
 * by default, while local/test allow unverified sign-in. Required verification
 * fails closed when the mail binding or sender is unusable.
 *
 * The installation application origin (`APP_URL`) is mandatory and validated
 * here because device-authorization verification links are absolute and pinned
 * to it; the API never derives consent URLs from a forwarded request host.
 *
 * @param env - Worker environment bindings containing database and auth configuration.
 * @returns Configured Better Auth instance.
 * @throws {Error} When the secret or application origin is missing/insecure in
 *   a deployed environment, or required email verification lacks a usable mail
 *   binding and sender.
 */
export async function betterAuthFor(env: ApiWorkerEnv): Promise<BetterAuthInstance> {
  const isLocalOrTest = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
  const requestOwnedPool = env.ENVIRONMENT === "local" || env.DATABASE_POOL_MODE === "request";
  const secret =
    env.BETTER_AUTH_SECRET?.trim() ||
    (isLocalOrTest ? "meltiply-local-auth-secret-32-chars-long" : undefined);

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET must be configured in staging and production");
  }
  const baseURL = env.APP_URL?.trim() || undefined;
  // Validate the installation origin and pin the consent URL to it. This
  // throws before any auth instance exists when APP_URL is missing, insecure
  // outside local development, or not a canonical origin.
  const deviceVerification = deviceVerificationUri(env);
  const origins = `${baseURL ?? ""}\n${env.ALLOWED_ORIGINS?.trim() || ""}`;
  const requireEmailVerification = requiresEmailVerification(env);
  const senderAddress = mailSenderConfiguration(env);
  const mailUsable =
    senderAddress !== undefined && env.MAIL !== undefined && typeof env.MAIL.send === "function";

  if (requireEmailVerification && !mailUsable) {
    throw new Error(
      "MAIL binding and MAIL_FROM_ADDRESS must be usable when email verification is required",
    );
  }

  const databaseConnectionString = env.DB_SYSTEM?.connectionString;
  if (
    !requestOwnedPool &&
    betterAuthCached &&
    betterAuthCached.secret === secret &&
    betterAuthCached.baseURL === baseURL &&
    betterAuthCached.origins === origins &&
    betterAuthCached.environment === env.ENVIRONMENT &&
    betterAuthCached.requireEmailVerification === requireEmailVerification &&
    betterAuthCached.databaseConnectionString === databaseConnectionString &&
    betterAuthCached.mailBinding === env.MAIL &&
    betterAuthCached.mailFromAddress === senderAddress?.email &&
    betterAuthCached.mailFromName === senderAddress?.name &&
    betterAuthCached.setupSecret === env.AUTH_SETUP_SECRET
  ) {
    return betterAuthCached.value;
  }

  const trustedOrigins = Array.from(allowedOriginsFor(env));
  // Exception: dynamic import avoids loading pg in workerd unit test isolates.
  const { systemPoolFor } = await import("./database");
  const database = systemPoolFor(env);
  const auth = authPolicyHandler(
    env,
    await createBetterAuth({
      baseURL,
      database,
      deviceAuthorization: {
        clientId: DEVICE_CLIENT_ID,
        expiresIn: DEVICE_CODE_EXPIRES_IN,
        interval: DEVICE_POLL_INTERVAL,
        verificationUri: deviceVerification,
      },
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

  if (!requestOwnedPool) {
    betterAuthCached = {
      baseURL,
      databaseConnectionString,
      environment: env.ENVIRONMENT,
      mailBinding: env.MAIL,
      mailFromAddress: senderAddress?.email,
      mailFromName: senderAddress?.name,
      origins,
      requireEmailVerification,
      secret,
      setupSecret: env.AUTH_SETUP_SECRET,
      value: auth,
    };
  }

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
  // Device-flow abuse controls. Issuance and consent actions are per caller;
  // token polling is additionally budgeted per device code so the advertised
  // five-second interval is enforced across Worker isolates without relying on
  // isolate-local state.
  "device-code": { maxAttempts: 20, windowSeconds: 600 },
  "device-verify": { maxAttempts: 30, windowSeconds: 600 },
  "device-approval": { maxAttempts: 20, windowSeconds: 600 },
  "device-token": { maxAttempts: 1, windowSeconds: 5 },
};

/**
 * Per-subject rate-limit budget. Token polling uses a tight per-device window
 * while retaining a looser per-caller ceiling, so one installation cannot be
 * flooded by many devices behind the same address.
 */
interface AuthRateLimitSubject {
  rule: AuthRateLimitRule;
  subject: string;
}

/** Token polling callers may legitimately poll once per five seconds per device. */
const DEVICE_TOKEN_IP_RULE: AuthRateLimitRule = { maxAttempts: 120, windowSeconds: 60 };

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
  const email = await requestStringField(request, "email");
  return email?.toLowerCase();
}

/**
 * Reads a non-empty string field from a cloned JSON auth request body without
 * consuming it. Used to hash credential-bearing subjects before rate limiting,
 * so device codes and emails never reach the limit store in plaintext.
 *
 * @param request - Incoming auth request.
 * @param field - Top-level body field to read.
 * @returns Trimmed value, or undefined when absent or not a non-empty string.
 */
async function requestStringField(request: Request, field: string): Promise<string | undefined> {
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === "object" && field in body) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // Non-JSON or missing bodies simply have no usable identity.
  }
  return undefined;
}

/**
 * Enforces the database-backed fixed-window rate limit for one Better Auth request.
 *
 * Records attempts through `public.auth_rate_limit_hit()` keyed by action plus a
 * SHA-256 subject (`email:<hash>` for credential endpoints, `device:<hash>` for
 * token polling, and always `ip:<hash>`), so limits are distributed across
 * isolates and cannot be bypassed by rotating any identity dimension. Token
 * polling checks and counts the caller IP before allocating or checking a
 * per-device bucket, so caller exhaustion bounds distinct-code ledger growth and
 * per-device throttling still consumes the caller budget. Fails closed: a
 * rate-limit store error propagates as a 500 rather than allowing unbounded
 * abuse.
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
  const ip = clientIp(request);
  const ipSubject = `ip:${await sha256Hex(ip ?? "unknown")}`;

  if (action === "device-token") {
    const callerRetryAfter = await authRateLimitHit(env, action, ipSubject, DEVICE_TOKEN_IP_RULE);
    if (callerRetryAfter !== null) {
      return { retryAfterSeconds: callerRetryAfter, status: "limited" };
    }
    const deviceCode = await requestStringField(request, "device_code");
    if (deviceCode) {
      const deviceRetryAfter = await authRateLimitHit(
        env,
        action,
        `device:${await sha256Hex(deviceCode)}`,
        rule,
      );
      if (deviceRetryAfter !== null) {
        return { retryAfterSeconds: deviceRetryAfter, status: "limited" };
      }
    }
    return { status: "ok" };
  }

  const subjects: AuthRateLimitSubject[] = [];
  if (EMAIL_RATE_LIMIT_ACTIONS.has(action)) {
    const email = await requestEmail(request);
    if (email) {
      subjects.push({ rule, subject: `email:${await sha256Hex(email)}` });
    }
  }
  subjects.push({ rule, subject: ipSubject });
  for (const { rule: subjectRule, subject } of subjects) {
    const retryAfterSeconds = await authRateLimitHit(env, action, subject, subjectRule);
    if (retryAfterSeconds !== null) {
      return { retryAfterSeconds, status: "limited" };
    }
  }
  return { status: "ok" };
}
