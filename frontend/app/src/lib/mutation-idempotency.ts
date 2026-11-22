import { useState } from "react";

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

export function mutationFingerprint(input: unknown): string {
  return JSON.stringify(normalize(input)) ?? "undefined";
}

const MAX_ACTIVE_FINGERPRINTS = 64;

export function createMutationKeyTracker(createKey: () => string = createMutationKey) {
  const active = new Map<string, string>();

  return {
    clear(fingerprint?: string): void {
      if (fingerprint === undefined) {
        active.clear();
        return;
      }
      active.delete(fingerprint);
    },
    keyFor(input: unknown): string {
      const fingerprint = mutationFingerprint(input);
      const existing = active.get(fingerprint);
      if (existing !== undefined) return existing;
      if (active.size >= MAX_ACTIVE_FINGERPRINTS) {
        const oldest = active.keys().next().value;
        if (oldest !== undefined) active.delete(oldest);
      }
      const key = createKey();
      active.set(fingerprint, key);
      return key;
    },
  };
}

export function useMutationKeyTracker() {
  const [tracker] = useState(() => createMutationKeyTracker());
  return tracker;
}
