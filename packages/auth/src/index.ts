import { Context, Effect, Layer } from "effect";
import { AuthenticationRequiredError, ForbiddenError } from "@meltiply/domain";
import { escapeMailHtml } from "@meltiply/domain/mail-content";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

/**
 * Verified tenant identity extracted from a Better Auth JWT bearer credential.
 * `subject` is the Better Auth user id; `email` is normalized to lowercase;
 * `name` is present only when the token carried a non-empty display name.
 */
export interface JwtIdentity {
  email: string;
  /**
   * Live account verification state resolved from the database session. The
   * JWT itself does not carry it; session validation fills it so actor
   * resolution can require a verified mailbox in deployed environments.
   */
  emailVerified?: boolean;
  name?: string;
  subject: string;
  sessionId?: string;
}

/**
 * Tenant claims resolved server-side from a verified JWT identity and workspace
 * membership. `subject` is the Better Auth subject; `organizationId` /
 * `organizationRole` carry the resolved workspace binding for RLS claims.
 */
export interface SessionClaims {
  organizationId?: string;
  organizationRole?: string;
  subject: string;
  userId?: string;
}

export interface AccessVerifierConfig {
  audience: string;
  teamDomain: string;
}

export interface AccessClaims {
  email: string;
  subject: string;
}

/**
 * Issuer and audience a Better Auth tenant JWT must carry. The issuer is the
 * Better Auth base URL origin (e.g. `https://api.example.com`, without the
 * `/api/auth` path); the audience pins tokens to the API surface they were
 * minted for.
 */
export interface JwtVerifierConfig {
  audience: string;
  issuer: string;
}

export type JwtVerifier = (token: string) => Promise<JwtIdentity>;
export type AccessTokenVerifier = (token: string) => Promise<AccessClaims>;

/**
 * Normalizes an unknown value to a trimmed non-empty string or undefined.
 * Used during JWT claim parsing to reject empty or whitespace-only claim strings.
 *
 * @param value - Untrusted value from a decoded JWT claim.
 * @returns Trimmed string if non-empty, otherwise undefined.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Validates and normalizes a Cloudflare Access team domain to a canonical HTTPS origin.
 * Prevents origin confusion attacks by enforcing protocol, hostname regex (*.cloudflareaccess.com),
 * and absence of paths, credentials, query parameters, or URL fragments.
 *
 * @param value - Raw team domain string (e.g., "https://example.cloudflareaccess.com").
 * @returns Canonical HTTPS origin string without trailing slash.
 * @throws {TypeError} When domain is not an HTTPS canonical cloudflareaccess.com origin.
 */
function cloudflareAccessTeamDomain(value: string): string {
  const candidate = value.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== candidate ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(parsed.hostname)
    ) {
      throw new TypeError("invalid Access team domain");
    }
    return parsed.origin;
  } catch {
    throw new TypeError("Access team domain must be a canonical HTTPS cloudflareaccess.com origin");
  }
}

/**
 * Extracts a bearer token from an HTTP Authorization header value.
 * Used by API Worker authentication middleware to isolate incoming JWT credentials.
 *
 * @param authorization - Raw Authorization header value (e.g. "Bearer eyJhbG...").
 * @returns The token string if matched against the Bearer scheme, otherwise undefined.
 */
export function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

/**
 * Validates and extracts tenant identity claims from a verified Better Auth JWT payload.
 * The plugin mints `sub`, `email`, `sid`, and optional `name`. This parser
 * validates identity and extracts the session ID; protected API authorization
 * separately requires that ID to reference a live owner session.
 *
 * @param payload - Decoded JWT payload from a signature/issuer/audience-verified token.
 * @returns Validated JwtIdentity with lowercase email and optional display name/session ID.
 * @throws {TypeError} When subject or email is missing or empty.
 */
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

/**
 * Validates and extracts operator identity claims from a Cloudflare Access JWT payload.
 * Enforces that the token represents an Access application identity (`type === "app"`)
 * with a valid subject and normalized lowercase email address for operator audit logging.
 *
 * @param payload - Decoded JWT payload from a verified Cloudflare Access token.
 * @returns Validated AccessClaims containing normalized email and subject.
 * @throws {TypeError} When subject or email is missing/empty, or token type is not "app".
 */
export function accessClaims(payload: JWTPayload): AccessClaims {
  const subject = nonEmptyString(payload.sub);
  const email = nonEmptyString(payload.email)?.toLowerCase();
  if (!subject || !email || payload.type !== "app") {
    throw new TypeError("Access token requires an identity subject and email");
  }
  return { email, subject };
}

/**
 * Creates a JwtVerifier for Better Auth tenant JWTs using a custom key resolution getter.
 * Enforces signature, issuer, and audience via jose's jwtVerify, then narrows the
 * payload to JwtIdentity so malformed identity claims are rejected at the boundary.
 *
 * @param config - Required issuer and audience for tenant tokens.
 * @param getKey - JWTVerifyGetKey resolver (e.g. a local or remote JWKS key set).
 * @returns Async verification function accepting a raw JWT string and resolving to JwtIdentity.
 * @throws {TypeError} When issuer or audience is blank.
 */
export function createJwtVerifier(config: JwtVerifierConfig, getKey: JWTVerifyGetKey): JwtVerifier {
  const issuer = config.issuer.trim();
  const audience = config.audience.trim();
  if (!issuer || !audience) {
    throw new TypeError("JWT issuer and audience are required");
  }
  return async (token) => {
    const { payload } = await jwtVerify(token, getKey, {
      audience,
      issuer,
    });
    return jwtClaims(payload);
  };
}

/**
 * Creates a production JwtVerifier wired to the Better Auth `/api/auth/jwks` endpoint.
 * jose's createRemoteJWKSet fetches and caches the plugin-managed public keys, so
 * the API Worker verifies tenant JWTs without a database round-trip per request.
 *
 * @param config - Required issuer and audience for tenant tokens.
 * @param jwksUrl - Absolute URL of the Better Auth JWKS endpoint.
 * @returns Async verification function returning validated JwtIdentity for bearer tokens.
 */
export function createRemoteJwtVerifier(config: JwtVerifierConfig, jwksUrl: URL): JwtVerifier {
  return createJwtVerifier(config, createRemoteJWKSet(jwksUrl));
}

/**
 * Creates an AccessTokenVerifier for Cloudflare Access JWTs using a custom key resolution getter.
 * Enforces audience match and issuer identity against the normalized team domain origin.
 * The returned async verifier parses token payload into verified AccessClaims.
 *
 * @param config - Access configuration specifying the required audience and team domain.
 * @param getKey - JWTVerifyGetKey resolver (e.g. JWKS key set).
 * @returns Async verification function accepting a raw JWT string and resolving to AccessClaims.
 * @throws {TypeError} When team domain is invalid or audience is blank.
 */
export function createAccessTokenVerifier(
  config: AccessVerifierConfig,
  getKey: JWTVerifyGetKey,
): AccessTokenVerifier {
  const teamDomain = cloudflareAccessTeamDomain(config.teamDomain);
  const audience = config.audience.trim();
  if (!audience) {
    throw new TypeError("Access team domain and audience are required");
  }
  return async (token) => {
    const { payload } = await jwtVerify(token, getKey, {
      audience,
      issuer: teamDomain,
    });
    return accessClaims(payload);
  };
}

/**
 * Creates a production AccessTokenVerifier wired to Cloudflare Access public certs JWKS.
 * Derives the remote certs endpoint at `${teamDomain}/cdn-cgi/access/certs` using jose's createRemoteJWKSet.
 *
 * @param config - Access verifier configuration containing audience and team domain.
 * @returns Async verification function returning validated AccessClaims for operator requests.
 */
export function createCloudflareAccessTokenVerifier(
  config: AccessVerifierConfig,
): AccessTokenVerifier {
  const teamDomain = cloudflareAccessTeamDomain(config.teamDomain);
  return createAccessTokenVerifier(
    { ...config, teamDomain },
    createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)),
  );
}

/**
 * Verifies an incoming Better Auth JWT bearer credential and returns the tenant
 * identity as a typed Effect. Maps any signature, issuer, audience, expiry, or
 * claim-shape failure to AuthenticationRequiredError to fail closed.
 *
 * @param verifier - Configured JwtVerifier instance.
 * @param token - Raw bearer JWT string from the Authorization header.
 * @returns Effect resolving to JwtIdentity or failing with AuthenticationRequiredError.
 */
export function verifyJwtTokenEffect(
  verifier: JwtVerifier,
  token: string,
): Effect.Effect<JwtIdentity, AuthenticationRequiredError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new AuthenticationRequiredError({
        message: cause instanceof Error ? cause.message : "Authentication required",
      }),
    try: async () => verifier(token),
  });
}

/**
 * Verifies a Cloudflare Access assertion JWT and returns operator identity claims as a typed Effect.
 * Enforces fail-closed semantics by mapping audience, signature, or issuer mismatches to ForbiddenError.
 *
 * @param verifier - Configured AccessTokenVerifier instance.
 * @param token - Raw Cf-Access-Jwt-Assertion header string.
 * @returns Effect resolving to AccessClaims or failing with ForbiddenError.
 */
export function verifyAccessTokenEffect(
  verifier: AccessTokenVerifier,
  token: string,
): Effect.Effect<AccessClaims, ForbiddenError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new ForbiddenError({
        message: cause instanceof Error ? cause.message : "Forbidden",
      }),
    try: async () => verifier(token),
  });
}

/**
 * Service shape describing effectful tenant JWT and operator access token verification.
 */
export interface AuthServiceShape {
  readonly verifyAccessToken: (token: string) => Effect.Effect<AccessClaims, ForbiddenError>;
  readonly verifyJwtToken: (
    token: string,
  ) => Effect.Effect<JwtIdentity, AuthenticationRequiredError>;
}

/**
 * Effect service tag for authentication and operator authorization boundaries.
 */
export class AuthService extends Context.Service<AuthService, AuthServiceShape>()("AuthService") {}

/**
 * Settings for the installed Better Auth device-authorization plugin.
 *
 * The flow is a first-party session grant for the supported CLI client, not a
 * general OAuth provider: the client identifier is matched exactly, no scope
 * grants additional capabilities, and the host supplies the application-origin
 * verification URL so links never follow a forwarded API origin.
 */
export interface BetterAuthDeviceAuthorizationConfig {
  /** Exact supported client identifier (melti-cli). */
  clientId: string;
  /** Short lifetime for a pending device request, in Better Auth time form. */
  expiresIn: string;
  /** Minimum polling interval enforced by the plugin, in Better Auth time form. */
  interval: string;
  /** Absolute same-origin browser verification URL, e.g. `https://app.example/device`. */
  verificationUri: string;
}

export interface BetterAuthConfig {
  baseURL?: string;
  database: unknown;
  /**
   * Enables the installed Better Auth device-authorization plugin as a
   * first-party session grant for the supported CLI client. The browser
   * verification URL must be absolute and same-origin with the installation
   * application; the API never derives it from a forwarded request origin.
   */
  deviceAuthorization?: BetterAuthDeviceAuthorizationConfig;
  email?: BetterAuthEmailConfig;
  /**
   * Live account-activity check invoked before a session is created. The host
   * resolves suspension from its own account record; returning false blocks
   * sign-in for a suspended account. Omitting the callback permits sessions
   * (identity creation is separately gated by the host's invite-only policy).
   */
  isAccountActive?: (userId: string) => Promise<boolean>;
  jwt?: {
    audience?: string;
    issuer?: string;
  };
  /**
   * Whether sign-in rejects users whose email is not yet verified. This is a
   * security policy decided by the caller — never derived from whether
   * `email` delivery is configured, so a missing mail configuration cannot
   * silently weaken verification requirements.
   */
  requireEmailVerification: boolean;
  secret: string;
  trustedOrigins?: string[];
}

/**
 * Transactional email delivery configuration for Better Auth verification and
 * recovery.
 *
 * `send` is the provider-neutral mail capability injected by the host (the API
 * Worker supplies its shared `MailSender`): it receives the fully rendered
 * subject/body plus the action URL Better Auth generated (verification link or
 * password-reset link) and may resolve an opaque receipt this package ignores.
 * The sender identity lives in that injected capability, so this package
 * carries no `from` field and stays free of provider SDK dependencies.
 */
export interface BetterAuthEmailConfig {
  send: (message: { html: string; subject: string; text: string; to: string }) => Promise<unknown>;
}

/**
 * Minimal live session identity the API Worker needs to bind browser consent
 * to the browser session that verified a device code. Only identifiers are
 * exposed; session tokens and user records stay inside Better Auth.
 */
export interface BetterAuthSessionIdentity {
  session: { id: string };
  user: { id: string };
}

/**
 * Minimal Better Auth surface the API Worker depends on: the fetch handler that
 * serves `/api/auth/*` (sign-in, sign-up, device authorization, `/token`,
 * `/jwks`) plus a live-session lookup for consent ownership. Session state
 * stays inside that surface; protected `/api/v1` routes authenticate exclusively
 * with the bearer JWT minted there.
 */
export interface BetterAuthShape {
  handler: (request: Request) => Promise<Response>;
  /**
   * Resolves the live browser session carried by request cookies. Returns
   * identifiers only, so callers cannot read or transport the session secret.
   */
  getSession?: (headers: Headers) => Promise<BetterAuthSessionIdentity | null>;
}

export type BetterAuthInstance = BetterAuthShape;

/**
 * Creates a self-hosted Better Auth instance backed by PostgreSQL.
 * Dynamically loads Better Auth to prevent module-evaluation side effects in serverless isolates.
 * When `config.email` is provided, verification and password-recovery delivery are wired
 * through the injected neutral sender; action links use shared HTML escaping while
 * plain-text bodies stay raw. `config.requireEmailVerification` independently
 * controls whether sign-in requires a verified email.
 *
 * JWTs include the database session id (`sid`), never its bearer secret. The API
 * checks that session on every protected operation, so revocation is immediate.
 * Cookie caching is disabled for the same reason. Password reset revokes all
 * sessions; TOTP enrollment requires confirmation and backup codes are encrypted.
 *
 * @param config - Database pool, secret, verification policy, optional baseURL/trustedOrigins, JWT claims, and email delivery.
 * @returns Configured Better Auth instance.
 */
export async function createBetterAuth(config: BetterAuthConfig): Promise<BetterAuthInstance> {
  // Exception: dynamic imports avoid loading pg and plugin code in workerd unit test isolates
  const { betterAuth } = await import("better-auth");
  const { bearer, deviceAuthorization, jwt, twoFactor } = await import("better-auth/plugins");
  const email = config.email;
  // Normalize and validate the device flow up front. The verification URL is
  // always absolute (Better Auth would otherwise resolve it against the
  // forwarded request origin) and same-origin with the configured installation
  // base URL, so a proxy host can never redirect consent to another site.
  const device = config.deviceAuthorization
    ? {
        ...config.deviceAuthorization,
        clientId: config.deviceAuthorization.clientId.trim(),
        verificationUri: new URL(config.deviceAuthorization.verificationUri).href,
      }
    : undefined;
  if (device && !device.clientId) {
    throw new TypeError("device authorization requires an exact client identifier");
  }
  const deviceClientId = device?.clientId;
  if (device && config.baseURL) {
    const installationOrigin = new URL(config.baseURL).origin;
    if (new URL(device.verificationUri).origin !== installationOrigin) {
      throw new TypeError("device authorization verification URI must be same-origin");
    }
  }
  const instance = betterAuth({
    baseURL: config.baseURL,
    database: config.database,
    appName: "Meltiply",
    logger: { disabled: true },
    // The API owns authoritative PostgreSQL rate limits; no isolate-local limit.
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (config.isAccountActive && !(await config.isAccountActive(session.userId))) {
              return false;
            }
            return { data: session };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      ...(email
        ? {
            sendResetPassword: async ({
              url,
              user,
            }: {
              url: string | URL;
              user: { email: string };
            }) => {
              const link = String(url);
              await email.send({
                html: `<p>Reset your Meltiply password by opening <a href="${escapeMailHtml(link)}">this link</a>. The link expires soon; if you did not request a reset, ignore this email.</p>`,
                subject: "Reset your Meltiply password",
                text: `Reset your Meltiply password: ${link}\n\nIf you did not request a reset, ignore this email.`,
                to: user.email,
              });
            },
          }
        : {}),
    },
    ...(email
      ? {
          emailVerification: {
            // An invitation's callback returns to the acceptance route. The
            // verified browser needs a session there so membership can activate
            // without asking the invitee to sign in a second time.
            autoSignInAfterVerification: true,
            // sendOnSignUp decouples delivery from the enforcement flag: with a
            // sender configured, sign-up always emits a verification message —
            // required in deployed environments where verification is enforced,
            // and useful in local/test where it is not, so simulated delivery
            // still produces exercisable action links.
            sendOnSignUp: true,
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
          },
        }
      : {}),
    plugins: [
      // Accept the CLI session credential as a bearer transport for just the
      // auth surface. Token issuing, renewal, and sign-out then share the same
      // live-session checks as the browser cookie; /api/v1 still requires the
      // short-lived JWT and never reads this credential.
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
      // Standalone device flow: approval mints a first-party Better Auth
      // session for the exact CLI client. Scope is not an authority grant, and
      // the plugin's own expiry/polling/atomic-consume state machine remains
      // authoritative.
      ...(device
        ? [
            deviceAuthorization({
              expiresIn: device.expiresIn,
              interval: device.interval,
              validateClient: (clientId: string) => clientId === deviceClientId,
              verificationUri: device.verificationUri,
            }),
          ]
        : []),
    ],
    secret: config.secret,
    session: {
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

export interface CreateAuthServiceLiveOptions {
  access?: AccessVerifierConfig | AccessTokenVerifier;
  accessVerifier?: AccessTokenVerifier;
  jwt?: (JwtVerifierConfig & { jwksUrl: URL }) | JwtVerifier;
  jwtVerifier?: JwtVerifier;
}

/**
 * Creates a live production Layer for AuthService backed by Better Auth JWT and Cloudflare Access verification.
 * Validates configuration fail-closed: missing verifiers produce failing Effects rather than uncaught errors.
 *
 * @param options - Verifier functions or configurations for tenant JWTs and Cloudflare Access.
 * @returns Layer providing the production AuthService.
 */
export function createAuthServiceLive(
  options: CreateAuthServiceLiveOptions,
): Layer.Layer<AuthService, never, never> {
  let jwtVerifier: JwtVerifier | undefined = options.jwtVerifier;
  let jwtInitError: string | undefined;
  if (!jwtVerifier && options.jwt) {
    if (typeof options.jwt === "function") {
      jwtVerifier = options.jwt;
    } else {
      try {
        jwtVerifier = createRemoteJwtVerifier(options.jwt, options.jwt.jwksUrl);
      } catch (cause) {
        jwtInitError = cause instanceof Error ? cause.message : "Failed to initialize JWT verifier";
      }
    }
  }
  let accessVerifier: AccessTokenVerifier | undefined = options.accessVerifier;
  let accessInitError: string | undefined;
  if (!accessVerifier && options.access) {
    if (typeof options.access === "function") {
      accessVerifier = options.access;
    } else {
      try {
        accessVerifier = createCloudflareAccessTokenVerifier(options.access);
      } catch (cause) {
        accessInitError =
          cause instanceof Error ? cause.message : "Failed to initialize Access verifier";
      }
    }
  }

  const service: AuthServiceShape = {
    verifyAccessToken: (token) => {
      if (accessInitError || !accessVerifier) {
        return Effect.fail(
          new ForbiddenError({
            message: accessInitError ?? "Cloudflare Access verifier is unconfigured",
          }),
        );
      }
      return verifyAccessTokenEffect(accessVerifier, token);
    },
    verifyJwtToken: (token) => {
      if (jwtInitError || !jwtVerifier) {
        return Effect.fail(
          new AuthenticationRequiredError({
            message: jwtInitError ?? "Better Auth JWT verifier is unconfigured",
          }),
        );
      }
      return verifyJwtTokenEffect(jwtVerifier, token);
    },
  };

  return Layer.succeed(AuthService, service);
}

/**
 * Creates a test Layer for AuthService with predictable mock claims or custom overrides.
 * Provides safe defaults for both tenant JWT and operator access verification in unit tests.
 *
 * @param impl - Optional partial implementation overrides.
 * @returns Layer providing test AuthService.
 */
export function createAuthServiceTest(
  impl?: Partial<AuthServiceShape>,
): Layer.Layer<AuthService, never, never> {
  const service: AuthServiceShape = {
    verifyAccessToken:
      impl?.verifyAccessToken ??
      (() =>
        Effect.succeed({
          email: "operator@example.test",
          subject: "mock-access-user",
        })),
    verifyJwtToken:
      impl?.verifyJwtToken ??
      (() =>
        Effect.succeed({
          email: "alpha@example.test",
          name: "Alpha User",
          subject: "mock-user",
        })),
  };

  return Layer.succeed(AuthService, service);
}
