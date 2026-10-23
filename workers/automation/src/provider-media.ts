import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  type ConfiguredObjectStore,
  type ObjectUrlSigner,
} from "@meltiply/storage";

import type { DistributionProviderDependencies } from "./distribution-provider";
import type { AutomationEnv } from "./env";

/**
 * Remote-ingest URL lifetime covering the asynchronous platform retrieval window.
 * Providers such as TikTok (PULL_FROM_URL) and Meta fetch the object minutes to hours after
 * publication is accepted, so the URL must outlive scheduling, queueing, and provider-side
 * processing; 24 hours covers that window while staying inside the 7-day SigV4 presign bound
 * that constrains the fallback signer.
 * Tradeoff: the URL is a bearer credential — anyone holding it can read the object until it
 * expires — so the longer lifetime widens the exposure window if the URL leaks through logs
 * or provider-side retention. Access control is preserved by keeping the object private and
 * serving it only through the signed/authenticated delivery route, never a public bucket.
 *
 * The same window bounds the media hold a publication attempt records, so the objects a
 * frozen attempt can still be retrieving stay protected for exactly as long as any URL
 * handed to a Provider stays valid.
 */
export const providerMediaRetrievalLeaseSeconds = 24 * 60 * 60;

/**
 * API route prefix serving verified-domain provider media.
 * The Automation Worker signs URLs under this path on the `PUBLIC_API_URL` origin; the API
 * Worker verifies the signature and streams the private R2 object. The literal is duplicated
 * in `workers/api/src/core-routes.ts` because worker bundles cannot share source modules —
 * both sides must stay byte-identical. The provider registry derives TikTok's
 * media prefix from this route on PUBLIC_API_URL; any explicit
 * TIKTOK_MEDIA_URL_PREFIX must still cover emitted URLs.
 */
const providerMediaRoutePrefix = "/api/v1/provider-media/";

const textEncoder = new TextEncoder();

/**
 * Normalizes and validates a MIME content type string.
 * Strips parameters (e.g., `; charset=utf-8`), trims whitespace, and ensures valid `type/subtype` format.
 *
 * @param value - Candidate content type string.
 * @returns Lowercase normalized MIME type, or null if malformed.
 */
function normalizedContentType(value: string | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : null;
}

/**
 * Canonical signing payload bound into every provider-media URL signature.
 * The versioned domain-separation prefix keeps these HMACs distinct from any other
 * `TOKEN_ENCRYPTION_KEY`-derived MAC; expiry and object key are the only signed fields,
 * so a valid signature proves the API issued read access to exactly that key until
 * exactly that second.
 *
 * @param expiresAtSeconds - Unix seconds after which the URL stops verifying.
 * @param key - Object key the bearer may read.
 * @returns Canonical `v1\n<expires>\n<key>` payload string.
 */
function providerMediaPayload(expiresAtSeconds: number, key: string): string {
  return `meltiply-provider-media-v1\n${expiresAtSeconds}\n${key}`;
}

/**
 * Encodes bytes as unpadded URL-safe Base64 for signature transport in query parameters.
 *
 * @param bytes - Raw signature bytes.
 * @returns Base64url string without padding.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Computes the HMAC-SHA256 bearer signature over the canonical media payload.
 * `TOKEN_ENCRYPTION_KEY` doubles as signing material: it is already provisioned on both
 * workers, so verified delivery needs no additional secret distribution.
 *
 * @param secret - `TOKEN_ENCRYPTION_KEY` raw key material.
 * @param expiresAtSeconds - Unix seconds after which the URL stops verifying.
 * @param key - Object key the bearer may read.
 * @returns Base64url-encoded HMAC-SHA256 digest.
 */
async function providerMediaSignature(
  secret: string,
  expiresAtSeconds: number,
  key: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    textEncoder.encode(providerMediaPayload(expiresAtSeconds, key)),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Builds the verified-domain remote-ingest URL for an asset object, or undefined when
 * verified delivery is not configured (missing `TOKEN_ENCRYPTION_KEY`, or `PUBLIC_API_URL`
 * absent/not credential-free HTTPS — e.g. local `http://` development).
 * The object key travels in the path so `TIKTOK_MEDIA_URL_PREFIX` pathname-prefix validation
 * applies; `expires` and `signature` ride in the query string. The result is a bearer URL
 * valid for `providerMediaRetrievalLeaseSeconds`.
 *
 * @param env - Automation worker environment with PUBLIC_API_URL and TOKEN_ENCRYPTION_KEY.
 * @param key - Validated object key to authorize.
 * @returns Signed verified-domain URL, or undefined when unavailable.
 */
async function verifiedRemoteIngestUrl(
  env: AutomationEnv,
  key: string,
): Promise<string | undefined> {
  const base = env.PUBLIC_API_URL?.trim();
  const secret = env.TOKEN_ENCRYPTION_KEY;
  if (!base || !secret) return undefined;
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return undefined;
  }
  if (origin.protocol !== "https:" || origin.username || origin.password) {
    return undefined;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + providerMediaRetrievalLeaseSeconds;
  const signature = await providerMediaSignature(secret, expiresAt, key);
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${providerMediaRoutePrefix}${path}`, origin);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", signature);
  return url.toString();
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
        !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f\\]/.test(segment),
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
