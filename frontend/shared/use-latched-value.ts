import { useState } from "react";

export function useLatchedValue<T>(value: T | null | undefined): T | null {
  const [latched, setLatched] = useState<T | null>(value ?? null);
  if (value != null && value !== latched) setLatched(value);
  return value ?? latched;
}
