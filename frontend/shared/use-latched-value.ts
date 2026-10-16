import { useState } from "react";

/**
 * Keeps a dialog's content stable through its exit animation. Callers close a
 * dialog by clearing its value (`post → null`), but Radix keeps the content
 * mounted for the slide/pop-out, so rendering the cleared value flashes an
 * empty or relabelled dialog. This returns the live value while it is set and
 * the last non-null value after it clears: `post` → `post`, then `null` → last
 * `post`. Pass identity-stable values (state, memoized rows); a value that is a
 * new object every render would re-latch on every render.
 */
export function useLatchedValue<T>(value: T | null | undefined): T | null {
  const [latched, setLatched] = useState<T | null>(value ?? null);
  if (value != null && value !== latched) setLatched(value);
  return value ?? latched;
}
