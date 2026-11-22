import { normalizeSegment } from "./keys";

export const PROVIDER_MEDIA_ROUTE_PREFIX = "/api/v1/provider-media/";

const base64PaddingPattern = /=+$/;
const base64UrlPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

/**
 * Canonical signing payload bound into every provider-media URL signature.
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
