import { useState } from "react";

/**
 * Recursively normalizes an input payload by sorting all object keys lexicographically.
 * Ensures consistent JSON serialization for identical payloads regardless of property order.
 *
 * @param value Arbitrary input data structure to normalize.
 * @returns Key-sorted clone of the value or the primitive itself.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

/**
 * Generates a RFC 4122 v4 UUID string for API idempotency headers.
 * Uses `crypto.randomUUID` when available, falling back to CSPRNG byte generation
 * via `crypto.getRandomValues` in environments where `randomUUID` is missing.
 *
 * @param randomUUID Optional function matching `crypto.randomUUID`.
 * @param getRandomValues Optional generator; receives an ArrayBuffer-backed 16-byte array
 * and must return the random bytes used for the UUID fallback.
 * @returns Canonical hyphenated UUID string (e.g. `123e4567-e89b-12d3-a456-426614174000`).
 */
export function createMutationKey(
  randomUUID: (() => string) | null | undefined = crypto.randomUUID?.bind(crypto),
  getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  if (randomUUID) return randomUUID();

  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Creates an in-memory idempotency key tracker that caches a generated UUID for an input fingerprint.
 * Subsequent retries with the identical normalized payload reuse the same idempotency key,
 * while altering the payload issues a fresh key.
 *
 * @param createKey Optional UUID generator factory; defaults to `createMutationKey`.
 * @returns Tracker interface with `keyFor(input)` and `clear()` methods.
 */
export function createMutationKeyTracker(createKey: () => string = createMutationKey) {
  let active: { fingerprint: string; key: string } | null = null;

  return {
    clear(): void {
      active = null;
    },
    keyFor(input: unknown): string {
      const fingerprint = JSON.stringify(normalize(input)) ?? "undefined";
      if (!active || active.fingerprint !== fingerprint) {
        active = { fingerprint, key: createKey() };
      }
      return active.key;
    },
  };
}

/**
 * React hook that instantiates a stable `MutationKeyTracker` across renders.
 * Used by TanStack mutation hooks to safely associate retry attempts with consistent idempotency keys.
 *
 * @returns Stable `MutationKeyTracker` instance.
 */
export function useMutationKeyTracker() {
  const [tracker] = useState(() => createMutationKeyTracker());
  return tracker;
}
