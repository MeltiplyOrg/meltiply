import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  signProviderMediaUrl,
  type ConfiguredObjectStore,
  type ObjectUrlSigner,
} from "@meltiply/storage";

import type { DistributionProviderDependencies } from "./distribution-provider";
import type { AutomationEnv } from "./env";

const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const unsafeObjectKeyPattern = /[\u0000-\u001f\u007f\\]/;

/**
 * Remote-ingest URL lifetime covering the asynchronous platform retrieval window (24 hours).
 * Also bounds the media hold a publication attempt records so frozen media stays protected
 * for as long as any URL handed to a Provider remains valid.
 */
export const providerMediaRetrievalLeaseSeconds = 24 * 60 * 60;

/**
 * Normalizes and validates a MIME content type string.
 * Strips parameters (e.g., `; charset=utf-8`), trims whitespace, and ensures valid `type/subtype` format.
 *
 * @param value - Candidate content type string.
 * @returns Lowercase normalized MIME type, or null if malformed.
 */
function normalizedContentType(value: string | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && contentTypePattern.test(normalized) ? normalized : null;
}

/**
 * Builds the verified-domain remote-ingest URL for an asset object, or undefined when
 * verified delivery is not configured (missing `TOKEN_ENCRYPTION_KEY`, or `APP_URL`
 * absent/not credential-free HTTPS).
 *
 * @param env - Automation worker environment with APP_URL and TOKEN_ENCRYPTION_KEY.
 * @param key - Validated object key to authorize.
 * @returns Signed verified-domain URL, or undefined when unavailable.
 */
function verifiedRemoteIngestUrl(env: AutomationEnv, key: string): Promise<string | undefined> {
  return signProviderMediaUrl({
    appUrl: env.APP_URL,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + providerMediaRetrievalLeaseSeconds,
    key,
    secret: env.TOKEN_ENCRYPTION_KEY,
  });
}

/**
 * Validates an object key against path traversal and asset ownership rules.
 * Requires at least 3 segments with the second segment strictly matching the
 * asset ID, which holds for every publishable object kind under
 * `<org_id>/<asset_id>/`: the verified original, a ready rendition, or a
 * thumbnail. Staging keys never match, so unpromoted bytes can never be
 * delivered.
 *
 * @param assetId - Asset UUID that owns the media file.
 * @param key - Object key (e.g. "org-1/asset-1/rendition-webp").
 * @throws {TypeError} When key format is invalid or attempts path traversal.
 */
function validateObjectKey(assetId: string, key: string): void {
  const segments = key.split("/");
  if (
    segments.length < 3 ||
    segments[1] !== assetId ||
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || unsafeObjectKeyPattern.test(segment),
    )
  ) {
    throw new TypeError("provider media object key is invalid");
  }
}

/**
 * Verifies that the stored object's physical size and content type match recorded database metadata.
 *
 * @param request - Requested asset metadata containing fileSize and contentType.
 * @param object - Provider object metadata containing size and contentType.
 * @throws {TypeError} When file size or content type differs from stored metadata.
 */
function validateMetadata(
  request: {
    contentType: string;
    fileSize: number;
  },
  object: { contentType: string | null; size: number },
): void {
  if (
    !Number.isSafeInteger(request.fileSize) ||
    request.fileSize < 1 ||
    object.size !== request.fileSize ||
    normalizedContentType(object.contentType ?? undefined) !==
      normalizedContentType(request.contentType)
  ) {
    throw new TypeError("provider media metadata does not match the object store");
  }
}
/**
 * Resolves validated media for publication. Remote ingest prefers a 24-hour
 * verified-domain URL, otherwise lazily signs through the configured provider's
 * signer; TikTok rejects that fallback via its verified-domain prefix check.
 * Direct upload returns the object stream. Unusable storage, invalid keys, or
 * mismatched size/type fail; an injected signer overrides environment signing.
 *
 * The store comes from the shared provider factory, so a deployment on an
 * S3-compatible origin publishes and uploads exactly like one on R2.
 */
export function createProviderMediaResolver(
  env: AutomationEnv,
  signer: ObjectUrlSigner | undefined = undefined,
): NonNullable<DistributionProviderDependencies["mediaFor"]> {
  let resolvedSigner = signer;
  let resolvedStore: ConfiguredObjectStore | undefined;
  return async (request) => {
    if (!resolvedStore) {
      try {
        resolvedStore = createObjectStoreFromEnv(env);
      } catch {
        throw new TypeError("provider media object storage is unavailable");
      }
    }
    const store = resolvedStore;
    validateObjectKey(request.assetId, request.objectKey);
    const contentType = normalizedContentType(request.contentType);
    if (!contentType) {
      throw new TypeError("provider media content type is invalid");
    }

    if (request.transferMode === "remote_ingest") {
      const object = await store.head(request.objectKey);
      if (!object) throw new TypeError("provider media object is unavailable");
      validateMetadata(request, object);
      const verifiedUrl = await verifiedRemoteIngestUrl(env, request.objectKey);
      if (verifiedUrl) {
        return {
          contentType,
          fileSize: request.fileSize,
          mode: "remote_ingest",
          url: verifiedUrl,
        };
      }
      resolvedSigner ??= createObjectUrlSignerFromEnv(env);
      return {
        contentType,
        fileSize: request.fileSize,
        mode: "remote_ingest",
        url: await resolvedSigner.signDownload({
          expiresInSeconds: providerMediaRetrievalLeaseSeconds,
          key: request.objectKey,
        }),
      };
    }

    const object = await store.read(request.objectKey);
    if (!object) throw new TypeError("provider media object is unavailable");
    validateMetadata(request, object);
    return {
      body: object.body,
      contentType,
      fileSize: request.fileSize,
      mode: request.transferMode,
    };
  };
}
