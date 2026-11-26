/**
 * Converts an ArrayBuffer or Uint8Array to a lowercase hexadecimal string without intermediate array copies.
 */
export function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

/**
 * Validates byte range bounds shared by all `ObjectStore.readRange` implementations.
 */
export function assertValidByteRange(offset: number, maximumBytes: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
    throw new RangeError("maximumBytes must be between 1 and 1048576");
  }
}
