import { Moon, Pause, Play, Sun } from "lucide-react";
import type { ReactElement } from "react";

/**
 * Static theme-control content shared by React and Astro. Root CSS selects the
 * committed palette, avoiding hydration and independently delayed icon state.
 * Native data hooks select its parts; `className` preserves caller utilities.
 */
export function ThemeIcon({ className = "" }: { className?: string }): ReactElement {
  return (
    <span className={className} data-preference-icon="theme" aria-hidden="true">
      <Sun data-preference-glyph="sun" />
      <Moon data-preference-glyph="moon" />
    </span>
  );
}

/** Shows manual/OS motion state through native data hooks, preserving caller utility classes without hydration. */
export function MotionIcon({ className = "" }: { className?: string }): ReactElement {
  return (
    <span className={className} data-preference-icon="motion" aria-hidden="true">
      <Play data-preference-glyph="play" />
      <Pause data-preference-glyph="pause" />
    </span>
  );
}
