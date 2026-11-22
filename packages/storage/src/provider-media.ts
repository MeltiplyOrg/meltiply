/**
 * Shared verified-domain provider-media URL signing and verification.
 *
 * The Automation Worker signs `<APP_URL>/api/v1/provider-media/<key>?expires=<unix>&signature=<b64url>`
 * URLs for remote-ingest Platforms; the API Worker verifies the HMAC-SHA256 signature and streams
 * the private object. Keeping the route prefix, canonical payload, and constant-time crypto in
 * `@meltiply/storage` guarantees both workers stay byte-identical without duplicated code.
 */
import { normalizeSegment } from "./keys";

export const PROVIDER_MEDIA_ROUTE_PREFIX = "/api/v1/provider-media/";

const base64PaddingPattern = /=+$/;
const base64UrlPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

/**
 * Canonical signing payload bound into every provider-media URL signature.
 *
 * @param expiresAtSeconds - Unix seconds after which the URL stops verifying.
 * @param key - Object key the bearer may read.
 * @returns Versioned canonical `v1\n<expires>\n<key>` string.
 */
export function providerMediaPayload(expiresAtSeconds: number, key: string): string {
  return `meltiply-provider-media-v1\n${expiresAtSeconds}\n${key}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(base64PaddingPattern, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!base64UrlPattern.test(value)) return undefined;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Computes the Base64url HMAC-SHA256 bearer signature for a provider-media URL.
 *
 * @param secret - Raw HMAC signing secret (`TOKEN_ENCRYPTION_KEY`).
 * @param expiresAtSeconds - Unix seconds after which the signature expires.
 * @param key - Object key authorized by the signature.
 * @returns Unpadded Base64url HMAC-SHA256 digest.
 */
export async function signProviderMediaSignature(
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
 * Verifies a provider-media HMAC-SHA256 bearer signature in constant time.
 *
 * @param secret - Raw HMAC signing secret (`TOKEN_ENCRYPTION_KEY`), or undefined.
 * @param expiresAtSeconds - Signed expiry claim from the URL.
 * @param key - Signed object key claim from the URL path.
 * @param signature - Base64url signature from the `signature` query parameter.
 * @returns True only when the signature authenticates the expiry and key claims.
 */
export async function verifyProviderMediaSignature(
  secret: string | undefined,
  expiresAtSeconds: number,
  key: string,
  signature: string,
): Promise<boolean> {
  const digest = base64UrlDecode(signature);
  if (!secret || !digest || digest.length !== 32) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    digest,
    textEncoder.encode(providerMediaPayload(expiresAtSeconds, key)),
  );
}

/**
 * Builds a signed verified-domain provider-media URL on `appOrigin`, or returns
 * `undefined` when signing prerequisites (HTTPS credential-free origin, secret) are absent.
 *
 * @param input - App origin, signing secret, validated object key, and expiry instant in Unix seconds.
 * @returns Signed URL string or `undefined` when verified delivery is unavailable.
 */
export async function signProviderMediaUrl(input: {
  readonly appUrl?: string;
  readonly expiresAtSeconds: number;
  readonly key: string;
  readonly secret?: string;
}): Promise<string | undefined> {
  const base = input.appUrl?.trim();
  const secret = input.secret;
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
  const encodedKey = input.key
    .split("/")
    .map((segment) => encodeURIComponent(normalizeSegment("key", segment)))
    .join("/");
  const signature = await signProviderMediaSignature(secret, input.expiresAtSeconds, input.key);
  const url = new URL(`${PROVIDER_MEDIA_ROUTE_PREFIX}${encodedKey}`, origin);
  url.searchParams.set("expires", String(input.expiresAtSeconds));
  url.searchParams.set("signature", signature);
  return url.toString();
}
