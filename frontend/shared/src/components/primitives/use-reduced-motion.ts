import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Subscribes to the operating system's reduced-motion query. Motion's
 * `useReducedMotion` captures its value once at mount, so a preference change
 * while the page is open would never reach `SlidingHighlight`; this store
 * re-renders consumers for the life of the component.
 */
function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Reads the live browser preference; false where `matchMedia` is unavailable. */
function getReducedMotionSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/** Server and first-hydration snapshot; the client store corrects it before paint. */
const getServerReducedMotionSnapshot = () => false;

/**
 * Tracks the OS reduced-motion preference, including changes after mount.
 * `useSyncExternalStore` supplies the server snapshot so static rendering never
 * reads `window`, and a changed preference re-renders consumers immediately.
 *
 * @returns Whether the browser currently asks for reduced motion.
 */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getServerReducedMotionSnapshot,
  );
}
