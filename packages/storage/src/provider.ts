import type { ConfiguredObjectStore } from "./object-store";
import { createR2SignerFromEnv, R2ObjectStore, type R2BucketLike, type R2SigV4Signer } from "./r2";
import { S3ObjectStore, type S3SigV4SignerOptions, S3SigV4Signer } from "./s3";

const regionPattern = /^[a-z0-9-]+$/;

/** Object storage backends Meltiply can be pointed at. */
export type ObjectStorageProvider = "r2" | "s3";

const defaultObjectStorageProvider: ObjectStorageProvider = "r2";

/**
 * Every environment binding that participates in provider selection.
 *
 * Both worker environments structurally satisfy this shape, which is what lets
 * one construction path serve upload signing, media processing, retention
 * sweeps, and private media delivery.
 */
export interface ObjectStorageEnv {
  ASSETS?: R2BucketLike;
  ENVIRONMENT?: string;
  OBJECT_STORAGE_PROVIDER?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
  R2_ENDPOINT_PATH_PREFIX?: string;
  R2_SECRET_ACCESS_KEY?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_REGION?: string;
  S3_SECRET_ACCESS_KEY?: string;
}

/** One provider binding and whether the environment actually configures it. */
export interface ObjectStorageBindingStatus {
  name: string;
  ready: boolean;
}

/**
 * Resolves the configured provider, defaulting to Cloudflare R2.
 */
export function objectStorageProvider(env: ObjectStorageEnv): ObjectStorageProvider {
  const configured = env.OBJECT_STORAGE_PROVIDER?.trim();
  if (!configured) return defaultObjectStorageProvider;
  if (configured === "r2" || configured === "s3") return configured;
  throw new TypeError("OBJECT_STORAGE_PROVIDER must be r2 or s3");
}

function allowsInsecureEndpoint(env: ObjectStorageEnv): boolean {
  return env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
}

function forcePathStyle(value: string | undefined): boolean {
  const configured = value?.trim();
  if (!configured) return true;
  const normalized = configured.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError("S3_FORCE_PATH_STYLE must be true or false");
}

function s3Region(value: string | undefined): string | undefined {
  const region = value?.trim();
  if (!region) return undefined;
  if (!regionPattern.test(region)) {
    throw new TypeError("S3_REGION must contain only lowercase letters, digits, and hyphens");
  }
  return region;
}

function s3SignerOptions(
  env: ObjectStorageEnv,
  allowInsecureEndpoint: boolean,
  now?: () => Date,
): S3SigV4SignerOptions {
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const endpoint = env.S3_ENDPOINT?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !bucket || !endpoint || !secretAccessKey) {
    throw new TypeError(
      "S3 object storage requires S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, and S3_SECRET_ACCESS_KEY",
    );
  }
  const region = s3Region(env.S3_REGION);
  return {
    accessKeyId,
    allowInsecureEndpoint,
    bucket,
    endpoint,
    forcePathStyle: forcePathStyle(env.S3_FORCE_PATH_STYLE),
    ...(now ? { now } : {}),
    ...(region ? { region } : {}),
    secretAccessKey,
  };
}

/**
 * Builds the presigned URL signer for the configured provider.
 *
 * Signing is independent of bucket access: a provider can be reachable for
 * uploads, previews, and downloads without this worker holding the R2 binding.
 * The development-only permission to sign a plain-HTTP origin is derived from
 * `ENVIRONMENT` alone, so no configuration value can enable it in deployment.
 */
export function createObjectUrlSignerFromEnv(
  env: ObjectStorageEnv,
  now?: () => Date,
): R2SigV4Signer | S3SigV4Signer {
  if (objectStorageProvider(env) === "s3") {
    return new S3SigV4Signer(s3SignerOptions(env, allowsInsecureEndpoint(env), now));
  }
  return createR2SignerFromEnv(env, now);
}

/**
 * Builds the object store for the configured provider.
 *
 * Every worker that touches stored bytes goes through this factory, so a
 * provider switch changes one configuration value rather than every call site.
 */
export function createObjectStoreFromEnv(env: ObjectStorageEnv): ConfiguredObjectStore {
  if (objectStorageProvider(env) === "s3") {
    return new S3ObjectStore(s3SignerOptions(env, allowsInsecureEndpoint(env)));
  }
  if (!env.ASSETS) {
    throw new TypeError("the ASSETS R2 binding is unavailable");
  }
  return new R2ObjectStore(env.ASSETS);
}

/**
 * Reports the bindings the configured provider needs, and whether each is
 * usable, so a readiness probe can describe a misconfigured provider instead of
 * reporting ready while every asset request fails.
 *
 * Readiness is semantic, not mere presence: `S3_ENDPOINT` is ready only when it
 * is an origin the signer would accept, `S3_FORCE_PATH_STYLE` must parse as a
 * boolean, and `S3_REGION` must be safe to include in a signing scope. The probe
 * agrees with `createObjectStoreFromEnv` rather than contradicting it. The R2
 * list keeps the historical binding names and readiness output unchanged.
 */
export function objectStorageBindings(
  env: ObjectStorageEnv,
): readonly ObjectStorageBindingStatus[] {
  if (objectStorageProvider(env) === "s3") {
    return [
      { name: "S3_ACCESS_KEY_ID", ready: Boolean(env.S3_ACCESS_KEY_ID?.trim()) },
      { name: "S3_BUCKET", ready: Boolean(env.S3_BUCKET?.trim()) },
      { name: "S3_ENDPOINT", ready: isUsableS3Endpoint(env) },
      { name: "S3_FORCE_PATH_STYLE", ready: isUsablePathStyle(env) },
      { name: "S3_REGION", ready: isUsableS3Region(env) },
      { name: "S3_SECRET_ACCESS_KEY", ready: Boolean(env.S3_SECRET_ACCESS_KEY?.trim()) },
    ];
  }
  return [
    { name: "ASSETS", ready: Boolean(env.ASSETS) },
    { name: "R2_ACCESS_KEY_ID", ready: Boolean(env.R2_ACCESS_KEY_ID) },
    { name: "R2_ACCOUNT_ID", ready: Boolean(env.R2_ACCOUNT_ID) },
    { name: "R2_BUCKET_NAME", ready: Boolean(env.R2_BUCKET_NAME) },
    { name: "R2_SECRET_ACCESS_KEY", ready: Boolean(env.R2_SECRET_ACCESS_KEY) },
  ];
}

function isUsableS3Endpoint(env: ObjectStorageEnv): boolean {
  const endpoint = env.S3_ENDPOINT?.trim();
  if (!endpoint) return false;
  try {
    new S3SigV4Signer({
      accessKeyId: "readiness",
      allowInsecureEndpoint: allowsInsecureEndpoint(env),
      bucket: env.S3_BUCKET?.trim() || "readiness",
      endpoint,
      secretAccessKey: "readiness",
    });
    return true;
  } catch {
    return false;
  }
}

function isUsablePathStyle(env: ObjectStorageEnv): boolean {
  try {
    forcePathStyle(env.S3_FORCE_PATH_STYLE);
    return true;
  } catch {
    return false;
  }
}

function isUsableS3Region(env: ObjectStorageEnv): boolean {
  try {
    s3Region(env.S3_REGION);
    return true;
  } catch {
    return false;
  }
}
