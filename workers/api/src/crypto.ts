// Worker-internal crypto primitives shared by webhook and idempotency paths
// (AUD-019/AUD-020). One SHA-256 hex pipeline and one RFC 4122 UUID pattern
// for the whole API Worker.

export const RFC4122_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Computes a lowercase hexadecimal SHA-256 digest of a string using Web Crypto.
 *
 * Provides a shared, dependency-free digest pipeline for idempotency keys,
 * invitation tokens, signed webhook payloads, and OAuth state routing keys.
 *
 * @param value - String to digest.
 * @returns 64-character lowercase hexadecimal SHA-256 hash string.
 * @example sha256Hex("ping") -> "d8a1c97a5...".
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
