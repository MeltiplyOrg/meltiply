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
import { mailSenderConfiguration } from "@meltiply/domain/mail-content";
import { createCloudflareMailSender } from "./mail";
import { authPolicyHandler } from "./auth-policy";
import { lazySystemPoolFor } from "./database-module";
import { clonedStringField } from "./request-json";

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

export interface AuthRateLimitResult {
  retryAfterSeconds?: number;
  status: "limited" | "ok";
}

interface RateLimitHitRow extends Record<string, unknown> {
  retry_after: number | null;
}

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
  const database = await lazySystemPoolFor(env);
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

interface AuthRateLimitRule {
  maxAttempts: number;
  windowSeconds: number;
}

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
  "device-code": { maxAttempts: 20, windowSeconds: 600 },
  "device-verify": { maxAttempts: 30, windowSeconds: 600 },
  "device-approval": { maxAttempts: 20, windowSeconds: 600 },
  "device-token": { maxAttempts: 1, windowSeconds: 5 },
};

interface AuthRateLimitSubject {
  rule: AuthRateLimitRule;
  subject: string;
}

const DEVICE_TOKEN_IP_RULE: AuthRateLimitRule = { maxAttempts: 120, windowSeconds: 60 };

const EMAIL_RATE_LIMIT_ACTIONS = new Set([
  "request-password-reset",
  "send-verification-email",
  "sign-in",
  "sign-up",
]);

async function authRateLimitHit(
  env: ApiWorkerEnv,
  action: string,
  subject: string,
  rule: AuthRateLimitRule,
): Promise<number | null> {
  const pool = await lazySystemPoolFor(env);
  const client = await pool.connect();
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

function clientIp(request: Request): string | undefined {
  const connecting = request.headers.get("cf-connecting-ip")?.trim();
  if (connecting) return connecting;
  return undefined;
}

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
    const deviceCode = await clonedStringField(request, "device_code");
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
    const email = (await clonedStringField(request, "email"))?.toLowerCase();
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
