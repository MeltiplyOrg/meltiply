import { isDevelopmentEnvironment } from "@meltiply/domain";

import type { ConfiguredObjectStore } from "./object-store";
import { createR2SignerFromEnv, R2ObjectStore, type R2BucketLike, type R2SigV4Signer } from "./r2";
import { S3ObjectStore, type S3SigV4SignerOptions, S3SigV4Signer } from "./s3";
import { validateSigV4Endpoint } from "./sigv4";

const regionPattern = /^[a-z0-9-]+$/;

export type ObjectStorageProvider = "r2" | "s3";

const defaultObjectStorageProvider: ObjectStorageProvider = "r2";

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

export interface ObjectStorageBindingStatus {
  name: string;
  ready: boolean;
}

export function objectStorageProvider(env: ObjectStorageEnv): ObjectStorageProvider {
  const configured = env.OBJECT_STORAGE_PROVIDER?.trim();
  if (!configured) return defaultObjectStorageProvider;
  if (configured === "r2" || configured === "s3") return configured;
  throw new TypeError("OBJECT_STORAGE_PROVIDER must be r2 or s3");
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

export function createObjectUrlSignerFromEnv(
  env: ObjectStorageEnv,
  now?: () => Date,
): R2SigV4Signer | S3SigV4Signer {
  if (objectStorageProvider(env) === "s3") {
    return new S3SigV4Signer(s3SignerOptions(env, isDevelopmentEnvironment(env), now));
  }
  return createR2SignerFromEnv(env, now);
}

export function createObjectStoreFromEnv(env: ObjectStorageEnv): ConfiguredObjectStore {
  if (objectStorageProvider(env) === "s3") {
    return new S3ObjectStore(s3SignerOptions(env, isDevelopmentEnvironment(env)));
  }
  if (!env.ASSETS) {
    throw new TypeError("the ASSETS R2 binding is unavailable");
  }
  return new R2ObjectStore(env.ASSETS);
}

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
    { name: "R2_ACCESS_KEY_ID", ready: Boolean(env.R2_ACCESS_KEY_ID?.trim()) },
    { name: "R2_ACCOUNT_ID", ready: Boolean(env.R2_ACCOUNT_ID?.trim()) },
    { name: "R2_BUCKET_NAME", ready: Boolean(env.R2_BUCKET_NAME?.trim()) },
    { name: "R2_SECRET_ACCESS_KEY", ready: Boolean(env.R2_SECRET_ACCESS_KEY?.trim()) },
  ];
}

function isUsableS3Endpoint(env: ObjectStorageEnv): boolean {
  const endpoint = env.S3_ENDPOINT?.trim();
  if (!endpoint) return false;
  try {
    validateSigV4Endpoint(endpoint, isDevelopmentEnvironment(env));
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
