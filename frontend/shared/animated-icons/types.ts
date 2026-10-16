import type { HTMLAttributes, Ref } from "react";

/**
 * Base properties supported by all interactive animated icon components.
 *
 * Extends standard HTML div element attributes to allow embedding within navigation links,
 * action buttons, or standalone toolbars while providing dedicated controls for icon dimension,
 * custom styling, and external hover state synchronisation.
 *
 * @property size - Icon viewport dimension in pixels (width and height). Defaults to 18px in most components.
 * @property strokeWidth - SVG stroke weight forwarded to every shape in the glyph; defaults to 2.
 *   Landing surfaces pass 1.6 to match the marketing line weight.
 * @property className - Optional CSS classes merged into the outer wrapping container.
 * @property isHovered - External hover trigger override. When `true`, activates the looping animation state.
 * @property ref - Forwarded to the wrapping div so island hosts (e.g. Astro islands) can observe
 *   the icon's DOM position and bind hover to the containing control.
 *
 * @example
 * ```tsx
 * <AnimatedSquarePen size={20} isHovered={isParentHovered} className="text-primary" />
 * ```
 */
export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  strokeWidth?: number;
  className?: string;
  isHovered?: boolean;
  ref?: Ref<HTMLDivElement>;
}
