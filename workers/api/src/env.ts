import { objectStorageBindings } from "@meltiply/storage";
import type { AccessClaims, JwtIdentity } from "@meltiply/auth";

import type { ResolvedActor } from "./actor-resolution";
import { mailSenderConfiguration } from "@meltiply/domain/mail-content";

import type { OAuthStateCoordinatorStub } from "@meltiply/contracts";

/** RPC contract of the OAuthStateCoordinator Durable Object (meltiply-state). */
export interface OAuthStateStub extends Rpc.DurableObjectBranded, OAuthStateCoordinatorStub {}

/** RPC contract of the Automation Worker entrypoint (meltiply-automation). */
export interface AutomationRelayStub {
  relayOutbox(): Promise<{
    claimed: number;
    dead: number;
    failed: number;
    published: number;
  }>;
  requestCommentsSync(organizationId: string, distributionId: string | null): Promise<number>;
}

export interface ApiWorkerEnv {
  ACCESS_POLICY_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  /** Optional additional browser origins; the canonical APP_URL is always trusted. */
  ALLOWED_ORIGINS?: string;
  ASSETS?: R2Bucket;
  AUTOMATION?: AutomationRelayStub;
  BETTER_AUTH_SECRET?: string;
  /** Private deployment bootstrap secret, at least 32 random characters; required before first signup. */
  AUTH_SETUP_SECRET?: string;
  /** Canonical public dashboard/API origin, also used for auth, OAuth and provider media. */
  APP_URL?: string;
  /** Trusted signing-key endpoint override; issuer/audience still use the public auth URL. */
  BETTER_AUTH_JWKS_URL?: string;
  /** Standalone workerd owns sockets per request; omitted keeps managed pool reuse. */
  DATABASE_POOL_MODE?: "request";
  DB_AUTHENTICATED?: Hyperdrive;
  DB_SYSTEM?: Hyperdrive;
  ENVIRONMENT: "local" | "preview" | "staging" | "test";
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  LOG_SAMPLE_RATE?: string;
  MAIL?: SendEmail;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  /** `"false"` allows the owner to sign in before email verification; omitted keeps the deployed default. */
  REQUIRE_EMAIL_VERIFICATION?: string;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  OAUTH_STATE?: DurableObjectNamespace<OAuthStateStub>;
  /** Object storage backend: `r2` (default) or `s3`. Selects which bindings below apply. */
  OBJECT_STORAGE_PROVIDER?: string;
  OPERATOR_HOSTNAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /**
   * Trusted S3-compatible R2 origin. Origin-only (no path); set only to point signed
   * URLs at a local signed S3 route fronting the same ASSETS bucket. Plain HTTP is
   * accepted only for loopback hosts or when `ENVIRONMENT` is `local`/`test`.
   */
  R2_ENDPOINT?: string;
  /**
   * Path prefix prepended to `/<bucket>/<key>` in signed URLs, for origins that serve
   * the bucket under a route (a local runtime serves it at `/cdn-cgi/local/r2/s3`).
   * Ignored unless `R2_ENDPOINT` is set.
   */
  R2_ENDPOINT_PATH_PREFIX?: string;
  /** Access key for the `s3` object storage provider; unused when the provider is `r2`. */
  S3_ACCESS_KEY_ID?: string;
  /** Bucket name for the `s3` object storage provider; unused when the provider is `r2`. */
  S3_BUCKET?: string;
  /** Origin only (no path) of the S3-compatible service, e.g. `https://minio.internal:9000`. */
  S3_ENDPOINT?: string;
  /** `true` (default) addresses the bucket in the path, `false` in the host. */
  S3_FORCE_PATH_STYLE?: string;
  /** S3 signing region; defaults to `us-east-1`. */
  S3_REGION?: string;
  /** Secret access key for the `s3` object storage provider; unused when the provider is `r2`. */
  S3_SECRET_ACCESS_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_LIVE_ACCEPTED?: string;
  TIKTOK_MEDIA_URL_PREFIX?: string;
  THREADS_CLIENT_ID?: string;
  THREADS_CLIENT_SECRET?: string;
  THREADS_ENGAGEMENT_LIVE_ACCEPTED?: string;
  THREADS_LIVE_ACCEPTED?: string;
  VERSION: string;
  YOUTUBE_LIVE_ACCEPTED?: string;
  YOUTUBE_SHORTS_CLIENT_ID?: string;
  YOUTUBE_SHORTS_CLIENT_SECRET?: string;
}

export interface BindingStatus {
  name: string;
  status: "ready" | "unavailable";
}

const requiredBindings: (keyof ApiWorkerEnv)[] = [
  "DB_SYSTEM",
  "DB_AUTHENTICATED",
  "APP_URL",
  "OAUTH_STATE",
  "TOKEN_ENCRYPTION_KEY",
];

const stagingAutomationBindings: (keyof ApiWorkerEnv)[] = ["AUTOMATION"];

const stagingAuthBindings: (keyof ApiWorkerEnv)[] = ["BETTER_AUTH_SECRET", "AUTH_SETUP_SECRET"];

/**
 * Reports whether a deployed session must prove email ownership.
 *
 * Local and test environments never enforce verification. Deployments enforce
 * it unless the host explicitly sets `REQUIRE_EMAIL_VERIFICATION=false`, which
 * self-hosting uses when no SMTP transport is configured.
 *
 * @param env - Worker environment bindings.
 * @returns True when email verification gates sign-in and owner authorization.
 */
export function requiresEmailVerification(env: ApiWorkerEnv): boolean {
  if (env.REQUIRE_EMAIL_VERIFICATION?.trim() === "false") return false;
  return env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test";
}

/**
 * Resolves and validates the installation application origin.
 *
 * The application origin is the single trusted origin for browser sign-in,
 * device verification links, and auth callbacks. It must be a canonical
 * absolute origin (no credentials, path, query, or fragment). HTTP is allowed
 * only for loopback hosts in local/test; the environment label alone never
 * permits plaintext traffic to a remote host.
 *
 * @param env - Worker environment bindings.
 * @returns Canonical application origin without a trailing slash.
 * @throws {Error} When APP_URL is missing, malformed, non-canonical, or insecure.
 */
export function applicationOrigin(env: ApiWorkerEnv): string {
  const configured = env.APP_URL?.trim();
  if (!configured) {
    throw new Error("APP_URL is required for the installation application origin");
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("APP_URL must be an absolute installation origin");
  }
  // Compare against the parsed origin without a trailing-slash regex: the
  // value is deployment input, so a linear string comparison avoids a
  // polynomial scan on pathological slash runs.
  const canonicalOrigin = url.origin;
  const configuredOrigin =
    configured === canonicalOrigin
      ? canonicalOrigin
      : configured === `${canonicalOrigin}/`
        ? canonicalOrigin
        : undefined;
  if (url.username || url.password || url.search || url.hash || configuredOrigin === undefined) {
    throw new Error(
      "APP_URL must be a canonical installation origin without credentials, path, query, or fragment",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_URL must use HTTP or HTTPS");
  }
  // Browsers and DNS resolvers treat localhost and *.localhost as loopback.
  // Plain HTTP is a loopback-only affordance: it must never carry credentials
  // or consent links over a network, so a non-loopback origin always requires
  // HTTPS regardless of the environment label. Loopback stays usable for
  // self-hosted local installs that terminate TLS at their own gateway.
  const loopback =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("APP_URL must use HTTPS outside loopback-only development");
  }
  return url.origin;
}

// Check mail capability and normalized sender configuration, not mere presence.
const stagingMailBindings: (keyof ApiWorkerEnv)[] = ["MAIL", "MAIL_FROM_ADDRESS"];

/**
 * Reports the object-storage bindings the configured provider actually needs.
 *
 * Storage requirements come from the shared provider resolution rather than a
 * fixed list, so an S3 deployment is told about its own `S3_*` settings instead
 * of R2 names it does not have. An unparseable `OBJECT_STORAGE_PROVIDER` is
 * reported as a single unavailable component instead of throwing, so the probe
 * still answers with a usable diagnosis.
 *
 * @param env - Worker environment bindings.
 * @returns Readiness entries for the selected provider's bindings.
 */
function objectStorageStatuses(env: ApiWorkerEnv): BindingStatus[] {
  try {
    return objectStorageBindings(env).map((binding) => ({
      name: binding.name,
      status: binding.ready ? "ready" : "unavailable",
    }));
  } catch {
    return [{ name: "OBJECT_STORAGE_PROVIDER", status: "unavailable" }];
  }
}

/**
 * Reports readiness status for required and environment-specific Worker bindings.
 *
 * Evaluates core bindings for all environments, plus auth, mail delivery, and
 * Automation RPC bindings in staging, plus the object-storage bindings the
 * configured provider requires. Used by the `/api/v1/ready` probe.
 *
 * @param env - Worker environment bindings.
 * @returns Array of `BindingStatus` entries with name and "ready" | "unavailable" status.
 */
export function bindingStatuses(env: ApiWorkerEnv): BindingStatus[] {
  const requiresMail = requiresEmailVerification(env);
  const bindings =
    env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "preview"
      ? [
          ...requiredBindings,
          ...stagingAuthBindings,
          ...(requiresMail ? stagingMailBindings : []),
          ...stagingAutomationBindings,
        ]
      : requiredBindings;
  return [
    ...bindings.map((name) => {
      // `MAIL` is only ready when the Email Sending binding exposes a callable
      // `send`; `MAIL_FROM_ADDRESS` only when `mailSenderConfiguration` can
      // normalize a valid sender. Presence alone must not report ready — an
      // unusable binding or malformed sender fails closed. No send occurs: this
      // is a local capability check, not a DNS/deliverability probe.
      const ready =
        name === "MAIL"
          ? typeof env.MAIL?.send === "function"
          : name === "MAIL_FROM_ADDRESS"
            ? mailSenderConfiguration(env) !== undefined
            : name === "AUTH_SETUP_SECRET"
              ? typeof env[name] === "string" && env[name].length >= 32
              : Boolean(env[name]);
      return { name, status: ready ? ("ready" as const) : ("unavailable" as const) };
    }),
    ...objectStorageStatuses(env),
  ];
}

/**
 * Validates mandatory production and staging Worker bindings, credentials, and provider configurations.
 *
 * Ensures all required environment variables, Hyperdrive databases, R2 storage, a usable
 * Email Sending binding with a valid sender and live-accepted provider
 * credentials (Meta, TikTok, YouTube) are fully configured in staging. TikTok's
 * media prefix is optional: the provider registry derives it from APP_URL.
 *
 * The mail checks run before the presence list so a malformed sender or
 * unusable binding reports a precise cause instead of a bare missing name.
 *
 * @param env - Worker environment bindings to validate.
 * @throws {Error} If any required binding is missing or provider credential configuration is inconsistent.
 */
export function validateProductionBindings(env: ApiWorkerEnv): void {
  if (env.ENVIRONMENT !== "staging") return;
  applicationOrigin(env);
  if (requiresEmailVerification(env)) {
    if (typeof env.MAIL?.send !== "function") {
      throw new Error("MAIL must be an Email Sending binding exposing a callable send method");
    }
    if (!mailSenderConfiguration(env)) {
      throw new Error("MAIL_FROM_ADDRESS/MAIL_FROM_NAME must configure a valid sender");
    }
  }
  const missing = bindingStatuses(env)
    .filter((binding) => binding.status === "unavailable")
    .map((binding) => binding.name);
  if (missing.length > 0) {
    throw new Error(`missing required Worker bindings: ${missing.join(", ")}`);
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.trim().length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters in staging");
  }
  const facebookAccepted = env.FACEBOOK_LIVE_ACCEPTED?.trim() ?? "false";
  const instagramAccepted = env.INSTAGRAM_LIVE_ACCEPTED?.trim() ?? "false";
  const instagramEngagementAccepted = env.INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?.trim() ?? "false";
  const threadsAccepted = env.THREADS_LIVE_ACCEPTED?.trim() ?? "false";
  const engagementAccepted = env.THREADS_ENGAGEMENT_LIVE_ACCEPTED?.trim() ?? "false";
  const tiktokAccepted = env.TIKTOK_LIVE_ACCEPTED?.trim() ?? "false";
  const youtubeAccepted = env.YOUTUBE_LIVE_ACCEPTED?.trim() ?? "false";
  if (!["true", "false", ""].includes(facebookAccepted)) {
    throw new Error("FACEBOOK_LIVE_ACCEPTED must be true or false");
  }
  if (!["true", "false", ""].includes(instagramAccepted)) {
    throw new Error("INSTAGRAM_LIVE_ACCEPTED must be true or false");
  }
  if (!["true", "false", ""].includes(instagramEngagementAccepted)) {
    throw new Error("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
  }
  if (instagramEngagementAccepted === "true" && instagramAccepted !== "true") {
    throw new Error("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED requires INSTAGRAM_LIVE_ACCEPTED=true");
  }
  if (!["true", "false", ""].includes(threadsAccepted)) {
    throw new Error("THREADS_LIVE_ACCEPTED must be true or false");
  }
  if (!["true", "false", ""].includes(engagementAccepted)) {
    throw new Error("THREADS_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
  }
  if (engagementAccepted === "true" && threadsAccepted !== "true") {
    throw new Error("THREADS_ENGAGEMENT_LIVE_ACCEPTED requires THREADS_LIVE_ACCEPTED=true");
  }
  if (!["true", "false", ""].includes(tiktokAccepted)) {
    throw new Error("TIKTOK_LIVE_ACCEPTED must be true or false");
  }
  if (!["true", "false", ""].includes(youtubeAccepted)) {
    throw new Error("YOUTUBE_LIVE_ACCEPTED must be true or false");
  }
  if (facebookAccepted === "true" && (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET)) {
    throw new Error("accepted Facebook provider requires client ID and client secret bindings");
  }
  if (instagramAccepted === "true" && (!env.INSTAGRAM_CLIENT_ID || !env.INSTAGRAM_CLIENT_SECRET)) {
    throw new Error("accepted Instagram provider requires client ID and client secret bindings");
  }
  if (threadsAccepted === "true" && (!env.THREADS_CLIENT_ID || !env.THREADS_CLIENT_SECRET)) {
    throw new Error("accepted Threads provider requires client ID and client secret bindings");
  }
  if (tiktokAccepted === "true" && (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET)) {
    throw new Error("accepted TikTok provider requires client key and client secret bindings");
  }
  if (
    youtubeAccepted === "true" &&
    (!env.YOUTUBE_SHORTS_CLIENT_ID || !env.YOUTUBE_SHORTS_CLIENT_SECRET)
  ) {
    throw new Error("accepted YouTube provider requires client ID and client secret bindings");
  }
}

/**
 * Hono environment type that binds the Worker's env and request-scoped
 * variables. Shared across route modules and the validation layer.
 */
export type ApiWorkerEnvironment = {
  Bindings: ApiWorkerEnv;
  Variables: {
    actor: ResolvedActor;
    identity: JwtIdentity;
    operator: AccessClaims;
    requestId: string;
    traceId: string;
  };
};
