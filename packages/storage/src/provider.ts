import type { ConfiguredObjectStore, ObjectWriteUrlSigner } from "./object-store";
import { createR2SignerFromEnv, R2ObjectStore, type R2BucketLike } from "./r2";
import { S3ObjectStore, type S3SigV4SignerOptions, S3SigV4Signer } from "./s3";

/**
 * Object-storage provider selection.
 *
 * Cloudflare R2 remains the default so every existing deployment keeps working
 * untouched; an operator who sets `OBJECT_STORAGE_PROVIDER=s3` moves the same
 * code paths to any S3-compatible origin. Selection happens once, here, so no
 * worker can accidentally construct a store or signer for a different provider
 * than the one its configuration declares.
 */

/** Object storage backends Meltiply can be pointed at. */
export type ObjectStorageProvider = "r2" | "s3";

/** Provider assumed when `OBJECT_STORAGE_PROVIDER` is unset. */
const defaultObjectStorageProvider: ObjectStorageProvider = "r2";

/**
 * Every environment binding that participates in provider selection.
 *
 * Both worker environments structurally satisfy this shape, which is what lets
 * one construction path serve upload signing, media processing, retention
 * sweeps, and private media delivery.
 */
export interface ObjectStorageEnv {
  /** R2 bucket binding; only read when the provider is `r2`. */
  ASSETS?: R2BucketLike;
  /** Worker environment label; only `local`/`test` may sign a plain-HTTP origin. */
  ENVIRONMENT?: string;
  /** `r2` (default) or `s3`. */
  OBJECT_STORAGE_PROVIDER?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
  R2_ENDPOINT_PATH_PREFIX?: string;
  R2_SECRET_ACCESS_KEY?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  /** Origin only (no path), e.g. `https://minio.internal:9000`. */
  S3_ENDPOINT?: string;
  /** `true` (default) addresses the bucket in the path, `false` in the host. */
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
 *
 * @param env - Worker environment bindings.
 * @returns The selected provider name.
 * @throws {TypeError} When `OBJECT_STORAGE_PROVIDER` names an unknown provider.
 */
export function objectStorageProvider(env: ObjectStorageEnv): ObjectStorageProvider {
  const configured = env.OBJECT_STORAGE_PROVIDER?.trim();
  if (!configured) return defaultObjectStorageProvider;
  if (configured === "r2" || configured === "s3") return configured;
  throw new TypeError("OBJECT_STORAGE_PROVIDER must be r2 or s3");
}

/** True only in the environments that may sign a plain-HTTP origin. */
function allowsInsecureEndpoint(env: ObjectStorageEnv): boolean {
  return env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
}

/**
 * Parses the path-style addressing switch.
 *
 * @param value - Raw `S3_FORCE_PATH_STYLE` setting; unset means `true`.
 * @returns Whether the bucket belongs in the request path.
 * @throws {TypeError} When the value is present but not `true` or `false`.
 */
function forcePathStyle(value: string | undefined): boolean {
  const configured = value?.trim();
  if (!configured) return true;
  const normalized = configured.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError("S3_FORCE_PATH_STYLE must be true or false");
}

/**
 * Validates the S3 settings and returns them as signer options.
 *
 * @param env - Worker environment bindings carrying the S3 settings.
 * @param allowInsecureEndpoint - Development-only plain-HTTP allowance.
 * @returns Fully resolved signer configuration.
 * @throws {TypeError} When any required setting is missing or malformed.
 */
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
  const region = env.S3_REGION?.trim();
  return {
    accessKeyId,
    allowInsecureEndpoint,
    bucket,
    endpoint,
    forcePathStyle: forcePathStyle(env.S3_FORCE_PATH_STYLE),
    ...(now ? { now } : {}),
    // Unset region falls back to the signer's own default, so the fallback
    // lives in exactly one place.
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
 *
 * @param env - Worker environment bindings.
 * @param now - Optional clock override for deterministic tests.
 * @returns Configured signer for download, upload, multipart, and exact-write grants.
 * @throws {TypeError} When the provider is unknown or its credentials are incomplete or untrusted.
 */
export function createObjectUrlSignerFromEnv(
  env: ObjectStorageEnv,
  now?: () => Date,
): ObjectWriteUrlSigner {
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
 *
 * @param env - Worker environment bindings.
 * @returns Store implementing the full object contract, including streaming reads.
 * @throws {TypeError} When the provider is unknown, its bucket binding is missing, or its settings are incomplete.
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
 * is an origin the signer would accept, and `S3_FORCE_PATH_STYLE` only when it
 * is a boolean, so the probe agrees with `createObjectStoreFromEnv` rather than
 * contradicting it. The R2 list keeps the historical binding names, which is
 * what makes an existing deployment's readiness output unchanged.
 *
 * @param env - Worker environment bindings.
 * @returns One entry per binding the selected provider requires.
 * @throws {TypeError} When `OBJECT_STORAGE_PROVIDER` names an unknown provider.
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

/**
 * Reports whether `S3_ENDPOINT` is present and accepted as a signing origin.
 *
 * @param env - Worker environment bindings.
 * @returns True when the signer would accept the configured endpoint.
 */
function isUsableS3Endpoint(env: ObjectStorageEnv): boolean {
  const endpoint = env.S3_ENDPOINT?.trim();
  if (!endpoint) return false;
  try {
    // Constructing the signer is the single definition of "acceptable origin";
    // readiness reports it rather than re-deriving the rules.
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

/**
 * Reports whether `S3_FORCE_PATH_STYLE` is unset or a valid boolean.
 *
 * @param env - Worker environment bindings.
 * @returns True when the setting is absent or parses.
 */
function isUsablePathStyle(env: ObjectStorageEnv): boolean {
  try {
    forcePathStyle(env.S3_FORCE_PATH_STYLE);
    return true;
  } catch {
    return false;
  }
}
