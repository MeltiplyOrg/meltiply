import { useState } from "react";

/**
 * Returns `value` while it is set and the last non-null value after it clears, so dialog content
 * stays stable through its exit animation. Pass identity-stable values.
 */
export function useLatchedValue<T>(value: T | null | undefined): T | null {
  const [latched, setLatched] = useState<T | null>(value ?? null);
  if (value != null && value !== latched) setLatched(value);
  return value ?? latched;
}
