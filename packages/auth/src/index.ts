import { escapeMailHtml } from "@meltiply/domain/mail-content";
import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import type { TimeString } from "better-auth/plugins";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

const trailingSlashPattern = /\/$/;
const accessTeamHostnamePattern = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;
const bearerTokenPattern = /^Bearer ([^\s]+)$/;

/**
 * Identity from a verified Better Auth JWT. `clientChannel` and `emailVerified` are never JWT
 * claims; the host fills them from the live database session.
 */
export interface JwtIdentity {
  clientChannel?: "web" | "cli" | "unknown";
  email: string;
  emailVerified?: boolean;
  name?: string;
  subject: string;
  sessionId?: string;
}

/** Tenant claims resolved server-side from a verified identity and its Workspace membership. */
export interface SessionClaims {
  organizationId?: string;
  organizationRole?: string;
  subject: string;
  userId?: string;
}

interface AccessVerifierConfig {
  audience: string;
  teamDomain: string;
}

export interface AccessClaims {
  email: string;
  subject: string;
}

interface JwtVerifierConfig {
  audience: string;
  issuer: string;
}

export type JwtVerifier = (token: string) => Promise<JwtIdentity>;
export type AccessTokenVerifier = (token: string) => Promise<AccessClaims>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cloudflareAccessTeamDomain(value: string): string {
  const candidate = value.trim().replace(trailingSlashPattern, "");
  const parsed = URL.parse(candidate);
  if (
    parsed?.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== candidate ||
    !accessTeamHostnamePattern.test(parsed.hostname)
  ) {
    throw new TypeError("Access team domain must be a canonical HTTPS cloudflareaccess.com origin");
  }
  return parsed.origin;
}

export function bearerToken(authorization: string | undefined): string | undefined {
  return authorization?.match(bearerTokenPattern)?.[1];
}

/** Throws `TypeError` unless the payload carries a non-empty subject and email. */
export function jwtClaims(payload: JWTPayload): JwtIdentity {
  const subject = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  if (!subject || !email) {
    throw new TypeError("JWT requires an identity subject and email");
  }
  const name = nonEmptyString(payload.name);
  const sessionId = nonEmptyString(payload.sid);
  return { email, ...(name ? { name } : {}), ...(sessionId ? { sessionId } : {}), subject };
}

/** Throws `TypeError` unless the payload is an Access application identity (`type: "app"`). */
export function accessClaims(payload: JWTPayload): AccessClaims {
  const subject = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  if (!subject || !email || payload.type !== "app") {
    throw new TypeError("Access token requires an identity subject and email");
  }
  return { email, subject };
}

export function createJwtVerifier(config: JwtVerifierConfig, getKey: JWTVerifyGetKey): JwtVerifier {
  const issuer = config.issuer.trim();
  const audience = config.audience.trim();
  if (!issuer || !audience) {
    throw new TypeError("JWT issuer and audience are required");
  }
  return async (token) => {
    const { payload } = await jwtVerify(token, getKey, { audience, issuer });
    return jwtClaims(payload);
  };
}

export function createRemoteJwtVerifier(config: JwtVerifierConfig, jwksUrl: URL): JwtVerifier {
  return createJwtVerifier(config, createRemoteJWKSet(jwksUrl));
}

/** Verifies Access assertions against the team's `/cdn-cgi/access/certs` keys unless `getKey` is given. */
export function createCloudflareAccessTokenVerifier(
  config: AccessVerifierConfig,
  getKey?: JWTVerifyGetKey,
): AccessTokenVerifier {
  const issuer = cloudflareAccessTeamDomain(config.teamDomain);
  const audience = config.audience.trim();
  if (!audience) {
    throw new TypeError("Access audience is required");
  }
  const keys = getKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { audience, issuer });
    return accessClaims(payload);
  };
}

/** Device-authorization flow for the first-party CLI client; scope grants no extra capability. */
export interface BetterAuthDeviceAuthorizationConfig {
  clientId: string;
  expiresIn: TimeString;
  interval: TimeString;
  /** Absolute browser verification URL, same-origin with `baseURL`. */
  verificationUri: string;
}

export interface BetterAuthConfig {
  baseURL?: string;
  database: BetterAuthOptions["database"];
  deviceAuthorization?: BetterAuthDeviceAuthorizationConfig;
  email?: BetterAuthEmailConfig;
  /** Returning false blocks session creation for a suspended account. */
  isAccountActive?: (userId: string) => Promise<boolean>;
  jwt?: {
    audience?: string;
    issuer?: string;
  };
  /** Caller-decided policy, never inferred from whether `email` delivery is configured. */
  requireEmailVerification: boolean;
  secret: string;
  trustedOrigins?: string[];
}

/** Provider-neutral sender for verification and password-reset mail; the receipt is ignored. */
export interface BetterAuthEmailConfig {
  send: (message: { html: string; subject: string; text: string; to: string }) => Promise<unknown>;
}

/** Better Auth surface the API depends on. Session lookups expose identifiers only, never secrets. */
export interface BetterAuthInstance {
  handler: (request: Request) => Promise<Response>;
  getSession?: (
    headers: Headers,
  ) => Promise<{ session: { id: string }; user: { id: string } } | null>;
}

type ClientChannel = "web" | "cli" | "unknown";

interface SessionProvenance {
  readonly clientChannel: ClientChannel;
  readonly userId: string;
}

const sessionProvenanceByContext = new WeakMap<object, SessionProvenance>();

const webSessionPaths = new Set(["/sign-in/email", "/sign-up/email", "/verify-email"]);

async function retainSessionProvenance(context: GenericEndpointContext | null): Promise<void> {
  const current = context?.context.session;
  if (!context || !current) return;
  const stored = await context.context.adapter.findOne<SessionProvenance>({
    model: "session",
    where: [{ field: "id", value: current.session.id }],
  });
  if (!stored || stored.userId !== current.user.id) return;
  sessionProvenanceByContext.set(context.context, {
    clientChannel: stored.clientChannel,
    userId: stored.userId,
  });
}

function sessionClientChannel(
  context: GenericEndpointContext | null,
  userId: string,
): ClientChannel {
  const path = context?.path;
  if (path === "/device/token") return "cli";
  const provenance = context ? sessionProvenanceByContext.get(context.context) : undefined;
  if (provenance?.userId === userId) return provenance.clientChannel;
  if (path && (webSessionPaths.has(path) || path.startsWith("/two-factor/verify-"))) return "web";
  return "unknown";
}

function deviceAuthorizationSettings(
  config: BetterAuthConfig,
): BetterAuthDeviceAuthorizationConfig | undefined {
  if (!config.deviceAuthorization) return undefined;
  const clientId = config.deviceAuthorization.clientId.trim();
  if (!clientId) {
    throw new TypeError("device authorization requires an exact client identifier");
  }
  const verificationUrl = new URL(config.deviceAuthorization.verificationUri);
  if (config.baseURL && verificationUrl.origin !== new URL(config.baseURL).origin) {
    throw new TypeError("device authorization verification URI must be same-origin");
  }
  return { ...config.deviceAuthorization, clientId, verificationUri: verificationUrl.href };
}

function authMail(email: BetterAuthEmailConfig) {
  return {
    sendResetPassword: async ({ url, user }: { url: string | URL; user: { email: string } }) => {
      const link = String(url);
      await email.send({
        html: `<p>Reset your Meltiply password by opening <a href="${escapeMailHtml(link)}">this link</a>. The link expires soon; if you did not request a reset, ignore this email.</p>`,
        subject: "Reset your Meltiply password",
        text: `Reset your Meltiply password: ${link}\n\nIf you did not request a reset, ignore this email.`,
        to: user.email,
      });
    },
    sendVerificationEmail: async ({
      url,
      user,
    }: {
      url: string | URL;
      user: { email: string };
    }) => {
      const link = String(url);
      await email.send({
        html: `<p>Verify your Meltiply email address by opening <a href="${escapeMailHtml(link)}">this link</a>.</p>`,
        subject: "Verify your Meltiply email",
        text: `Verify your Meltiply email address: ${link}`,
        to: user.email,
      });
    },
  };
}

/**
 * Builds the Better Auth instance. JWTs carry the database session id (`sid`), never its secret,
 * and the API checks that session on every protected call, so cookie caching stays off and
 * revocation is immediate. Session `clientChannel` comes only from the issuing endpoint or the
 * authenticated predecessor session, never from request input. The `bearer` plugin accepts the CLI
 * session credential on `/api/auth/*` only; `/api/v1` accepts only the short-lived JWT.
 */
export async function createBetterAuth(config: BetterAuthConfig): Promise<BetterAuthInstance> {
  const { betterAuth } = await import("better-auth");
  const { bearer, deviceAuthorization, jwt, twoFactor } = await import("better-auth/plugins");
  const device = deviceAuthorizationSettings(config);
  const mail = config.email ? authMail(config.email) : undefined;
  const instance = betterAuth({
    baseURL: config.baseURL,
    database: config.database,
    appName: "Meltiply",
    logger: { disabled: true },
    rateLimit: { enabled: false },
    databaseHooks: {
      account: {
        update: {
          before: async (account, context) => {
            if (account.password !== undefined) await retainSessionProvenance(context);
          },
        },
      },
      user: {
        update: {
          before: async (user, context) => {
            if (
              "twoFactorEnabled" in user ||
              user.emailVerified !== undefined ||
              user.email !== undefined
            ) {
              await retainSessionProvenance(context);
            }
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (config.isAccountActive && !(await config.isAccountActive(session.userId))) {
              return false;
            }
            return {
              data: { ...session, clientChannel: sessionClientChannel(context, session.userId) },
            };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      ...(mail ? { sendResetPassword: mail.sendResetPassword } : {}),
    },
    ...(mail
      ? {
          emailVerification: {
            autoSignInAfterVerification: true,
            sendOnSignUp: true,
            sendVerificationEmail: mail.sendVerificationEmail,
          },
        }
      : {}),
    plugins: [
      bearer(),
      jwt({
        jwt: {
          ...(config.jwt?.audience ? { audience: config.jwt.audience } : {}),
          definePayload: ({ user, session }) => ({
            email: user.email,
            name: user.name,
            sid: session.id,
          }),
          expirationTime: "15m",
          ...(config.jwt?.issuer ? { issuer: config.jwt.issuer } : {}),
        },
        sessionCookieCache: false,
      }),
      twoFactor({
        issuer: "Meltiply",
        trustDeviceMaxAge: 0,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
      }),
      ...(device
        ? [
            deviceAuthorization({
              expiresIn: device.expiresIn,
              interval: device.interval,
              userCodeLength: 6,
              validateClient: (clientId: string) => clientId === device.clientId,
              verificationUri: device.verificationUri,
            }),
          ]
        : []),
    ],
    secret: config.secret,
    session: {
      additionalFields: {
        clientChannel: {
          type: ["web", "cli", "unknown"],
          defaultValue: "unknown",
          input: false,
          returned: false,
          required: true,
        },
      },
      cookieCache: { enabled: false },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: config.trustedOrigins,
  });
  return {
    handler: (request) => instance.handler(request),
    getSession: async (headers) => {
      const resolved = await instance.api.getSession({ headers });
      if (!resolved?.session?.id || !resolved.user?.id) return null;
      return { session: { id: resolved.session.id }, user: { id: resolved.user.id } };
    },
  };
}
