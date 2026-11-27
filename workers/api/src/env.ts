import { objectStorageBindings } from "@meltiply/storage";
import type { ProviderOriginSetting } from "@meltiply/providers";
import type { AccessClaims, JwtIdentity } from "@meltiply/auth";
import {
  isDevelopmentEnvironment,
  isLoopbackHostname,
  type WorkerEnvironment,
} from "@meltiply/domain";
import { mailSenderConfiguration } from "@meltiply/domain/mail-content";
import type { OAuthStateCoordinatorStub } from "@meltiply/contracts";

import type { ResolvedActor } from "./actor-types";

export interface OAuthStateStub extends Rpc.DurableObjectBranded, OAuthStateCoordinatorStub {}

export interface AutomationRelayStub {
  relayOutbox(): Promise<{
    claimed: number;
    dead: number;
    failed: number;
    published: number;
  }>;
  requestCommentsSync(organizationId: string, distributionId: string | null): Promise<number>;
}

export interface ApiWorkerEnv extends Partial<Record<ProviderOriginSetting, string>> {
  ACCESS_POLICY_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ALLOWED_ORIGINS?: string;
  ASSETS?: R2Bucket;
  AUTOMATION?: AutomationRelayStub;
  BETTER_AUTH_SECRET?: string;
  AUTH_SETUP_SECRET?: string;
  APP_URL?: string;
  BETTER_AUTH_JWKS_URL?: string;
  DATABASE_POOL_MODE?: "request";
  DEPLOYMENT_CATEGORY?: string;
  DB_AUTHENTICATED?: Hyperdrive;
  DB_SYSTEM?: Hyperdrive;
  ENVIRONMENT: WorkerEnvironment;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  LOG_SAMPLE_RATE?: string;
  MAIL?: SendEmail;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  REQUIRE_EMAIL_VERIFICATION?: string;
  REPORTING_FORCED_OFF?: string;
  REPORTING_POSTHOG_HOST?: string;
  REPORTING_POSTHOG_PROJECT_TOKEN?: string;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  OAUTH_STATE?: DurableObjectNamespace<OAuthStateStub>;
  OBJECT_STORAGE_PROVIDER?: string;
  OPERATOR_HOSTNAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_ENDPOINT_PATH_PREFIX?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_REGION?: string;
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

const deployedAutomationBindings: (keyof ApiWorkerEnv)[] = ["AUTOMATION"];

const deployedAuthBindings: (keyof ApiWorkerEnv)[] = ["BETTER_AUTH_SECRET", "AUTH_SETUP_SECRET"];

export function requiresEmailVerification(env: ApiWorkerEnv): boolean {
  if (env.ENVIRONMENT === "selfhost" && env.REQUIRE_EMAIL_VERIFICATION?.trim() === "false")
    return false;
  return !isDevelopmentEnvironment(env.ENVIRONMENT);
}

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
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("APP_URL must use HTTPS outside loopback-only development");
  }
  return url.origin;
}

const deployedMailBindings: (keyof ApiWorkerEnv)[] = ["MAIL", "MAIL_FROM_ADDRESS"];

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

export function bindingStatuses(env: ApiWorkerEnv): BindingStatus[] {
  const requiresMail = requiresEmailVerification(env);
  const bindings = !isDevelopmentEnvironment(env.ENVIRONMENT)
    ? [
        ...requiredBindings,
        ...deployedAuthBindings,
        ...(requiresMail ? deployedMailBindings : []),
        ...deployedAutomationBindings,
      ]
    : requiredBindings;
  return [
    ...bindings.map((name) => {
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

function readAcceptedFlag(
  env: ApiWorkerEnv,
  key:
    | "FACEBOOK_LIVE_ACCEPTED"
    | "INSTAGRAM_LIVE_ACCEPTED"
    | "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED"
    | "THREADS_LIVE_ACCEPTED"
    | "THREADS_ENGAGEMENT_LIVE_ACCEPTED"
    | "TIKTOK_LIVE_ACCEPTED"
    | "YOUTUBE_LIVE_ACCEPTED",
): boolean {
  const value = env[key]?.trim() ?? "false";
  if (value !== "true" && value !== "false" && value !== "") {
    throw new Error(`${key} must be true or false`);
  }
  return value === "true";
}

export function validateProductionBindings(env: ApiWorkerEnv): void {
  if (isDevelopmentEnvironment(env.ENVIRONMENT)) return;
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
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters in deployed environments");
  }
  const facebookAccepted = readAcceptedFlag(env, "FACEBOOK_LIVE_ACCEPTED");
  const instagramAccepted = readAcceptedFlag(env, "INSTAGRAM_LIVE_ACCEPTED");
  const instagramEngagementAccepted = readAcceptedFlag(env, "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED");
  const threadsAccepted = readAcceptedFlag(env, "THREADS_LIVE_ACCEPTED");
  const engagementAccepted = readAcceptedFlag(env, "THREADS_ENGAGEMENT_LIVE_ACCEPTED");
  const tiktokAccepted = readAcceptedFlag(env, "TIKTOK_LIVE_ACCEPTED");
  const youtubeAccepted = readAcceptedFlag(env, "YOUTUBE_LIVE_ACCEPTED");
  if (instagramEngagementAccepted && !instagramAccepted) {
    throw new Error("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED requires INSTAGRAM_LIVE_ACCEPTED=true");
  }
  if (engagementAccepted && !threadsAccepted) {
    throw new Error("THREADS_ENGAGEMENT_LIVE_ACCEPTED requires THREADS_LIVE_ACCEPTED=true");
  }
  if (facebookAccepted && (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET)) {
    throw new Error("accepted Facebook provider requires client ID and client secret bindings");
  }
  if (instagramAccepted && (!env.INSTAGRAM_CLIENT_ID || !env.INSTAGRAM_CLIENT_SECRET)) {
    throw new Error("accepted Instagram provider requires client ID and client secret bindings");
  }
  if (threadsAccepted && (!env.THREADS_CLIENT_ID || !env.THREADS_CLIENT_SECRET)) {
    throw new Error("accepted Threads provider requires client ID and client secret bindings");
  }
  if (tiktokAccepted && (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET)) {
    throw new Error("accepted TikTok provider requires client key and client secret bindings");
  }
  if (youtubeAccepted && (!env.YOUTUBE_SHORTS_CLIENT_ID || !env.YOUTUBE_SHORTS_CLIENT_SECRET)) {
    throw new Error("accepted YouTube provider requires client ID and client secret bindings");
  }
}

export type ApiWorkerEnvironment = {
  Bindings: ApiWorkerEnv;
  Variables: {
    actor: ResolvedActor | undefined;
    identity: JwtIdentity;
    operator: AccessClaims;
    requestId: string;
    traceId: string;
  };
};
