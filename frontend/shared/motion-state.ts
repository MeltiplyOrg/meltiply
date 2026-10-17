export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/** Reads the live OS accessibility preference; unavailable media queries mean normal motion. */
export function readSystemLowMotion(): boolean {
  try {
    return window.matchMedia(reducedMotionQuery).matches;
  } catch {
    return false;
  }
}

/** Allows spatial effects only outside the root presentation policy, OS reduction, and ink capture. */
export function motionAllowed(): boolean {
  return (
    typeof document !== "undefined" &&
    !document.documentElement.hasAttribute("data-low-motion") &&
    !readSystemLowMotion() &&
    !document.documentElement.hasAttribute("data-theme-ink")
  );
}
