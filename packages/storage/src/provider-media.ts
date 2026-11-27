import { PROVIDER_MEDIA_ROUTE_PREFIX } from "@meltiply/domain";

import { normalizeSegment } from "./keys";

export { PROVIDER_MEDIA_ROUTE_PREFIX };

const base64PaddingPattern = /=+$/;
const base64UrlPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

export function validateProviderMediaKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new TypeError("provider media object key is invalid");
  }
  const segments = trimmed.split("/");
  if (segments.length < 3 || segments[0] === "staging") {
    throw new TypeError("provider media object key is invalid");
  }
  return segments.map((segment) => normalizeSegment("key", segment)).join("/");
}

function providerMediaPayload(expiresAtSeconds: number, key: string): string {
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
 * Builds a signed verified-domain provider-media URL on `appUrl`, or returns
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
  const normalizedKey = validateProviderMediaKey(input.key);
  const encodedKey = normalizedKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const signature = await signProviderMediaSignature(secret, input.expiresAtSeconds, normalizedKey);
  const url = new URL(`${PROVIDER_MEDIA_ROUTE_PREFIX}${encodedKey}`, origin);
  url.searchParams.set("expires", String(input.expiresAtSeconds));
  url.searchParams.set("signature", signature);
  return url.toString();
}
