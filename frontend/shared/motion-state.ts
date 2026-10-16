import { readFunctionalStorage, writeFunctionalStorage } from "./cookie-consent";

/** Shared browser-local manual preference; only the literal "on" enables it. */
export const motionPreferenceStorageKey = "meltiply.low-motion";
export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/** Reads the live OS accessibility preference; unavailable media queries mean normal motion. */
export function readSystemLowMotion(): boolean {
  try {
    return window.matchMedia(reducedMotionQuery).matches;
  } catch {
    return false;
  }
}

/** Reads a consented manual choice; missing consent or inaccessible storage means no persisted override. */
export function readStoredManualLowMotion(): boolean {
  return readFunctionalStorage(motionPreferenceStorageKey) === "on";
}

/** Saves manual motion only with functional consent; current-page control state works without persistence. */
export function writeStoredManualLowMotion(enabled: boolean): void {
  writeFunctionalStorage(motionPreferenceStorageKey, enabled ? "on" : null);
}

/** Allows spatial effects only outside manual/OS low motion and an active ink capture; SSR stays static. */
export function motionAllowed(): boolean {
  return (
    typeof document !== "undefined" &&
    !document.documentElement.hasAttribute("data-low-motion") &&
    !readSystemLowMotion() &&
    !document.documentElement.hasAttribute("data-theme-ink")
  );
}
