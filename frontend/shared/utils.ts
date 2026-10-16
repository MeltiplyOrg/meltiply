import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["hairline", "btn", "card", "raised", "overlay"] }],
    },
  },
});

/**
 * Merges and deduplicates conditional class names using `clsx` and `tailwind-merge`.
 * Resolves Tailwind CSS utility conflicts in favor of subsequent arguments, including
 * Meltiply custom elevation shadows (`shadow-hairline`, `shadow-btn`, `shadow-card`, etc.).
 * Shared across the app, landing islands, and shared icon/effect components so both
 * frontends merge classes identically.
 *
 * @param inputs - Variable list of class values, objects, or arrays.
 * @returns Cleaned and merged class name string.
 */
export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs));
}
