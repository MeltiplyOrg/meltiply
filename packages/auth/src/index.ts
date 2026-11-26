import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { passwordResetMail, verificationMail } from "./auth-mail";
import { accessClaims, jwtClaims, type AccessClaims, type JwtIdentity } from "./claims";
import {
  deviceAuthorizationSettings,
  type BetterAuthDeviceAuthorizationConfig,
} from "./device-authorization";
import { clientChannelFor, type ClientChannel, type SessionProvenance } from "./session-channel";

export {
  accessClaims,
  bearerToken,
  jwtClaims,
  type AccessClaims,
  type JwtIdentity,
} from "./claims";
export type { BetterAuthDeviceAuthorizationConfig } from "./device-authorization";

const trailingSlashPattern = /\/$/;
const accessTeamHostnamePattern = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;

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

interface JwtVerifierConfig {
  audience: string;
  issuer: string;
}

export type JwtVerifier = (token: string) => Promise<JwtIdentity>;
export type AccessTokenVerifier = (token: string) => Promise<AccessClaims>;

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

const sessionProvenanceByContext = new WeakMap<object, SessionProvenance>();

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
  const provenanceForContext = context
    ? sessionProvenanceByContext.get(context.context)
    : undefined;
  return clientChannelFor(context?.path, provenanceForContext, userId);
}

function authMail(email: BetterAuthEmailConfig) {
  return {
    sendResetPassword: async ({ url, user }: { url: string | URL; user: { email: string } }) => {
      await email.send(passwordResetMail(String(url), user.email));
    },
    sendVerificationEmail: async ({
      url,
      user,
    }: {
      url: string | URL;
      user: { email: string };
    }) => {
      await email.send(verificationMail(String(url), user.email));
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
  const device = deviceAuthorizationSettings(config.deviceAuthorization, config.baseURL);
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
