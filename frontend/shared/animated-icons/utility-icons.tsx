import { useState } from "react";
import { m as motion } from "motion/react";
import { cn } from "../utils";
import type { AnimatedIconProps } from "./types";
import { useIconLoop } from "./use-icon-loop";
import { IconMotionFrame } from "./icon-motion-frame";

/**
 * Animated plus/add icon with spring-assisted 90° rotation.
 *
 * Feature requirements & motion behaviors:
 * - **Spring Spin**: On hover loop, rotates the crosshairs 90° clockwise using a spring overshoot curve
 *   (`[0.34, 1.56, 0.64, 1]`) over 0.45s to signal creation or addition.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Retains `overflow-visible` so rotating 90° crosshairs never truncate at the edge boundaries.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated plus SVG in the shared SVG-only motion frame.
 */
export function AnimatedPlus({
  size,
  className,
  isHovered: externalHovered,
  strokeWidth = 2,
  onMouseEnter,
  onMouseLeave,
  ...props
}: AnimatedIconProps) {
  const [internalHovered, setInternalHovered] = useState(false);
  const active = externalHovered || internalHovered;
  const controls = useIconLoop(active);

  return (
    <IconMotionFrame
      className={cn("inline-flex items-center justify-center shrink-0 overflow-visible", className)}
      style={size ? { width: size, height: size } : undefined}
      onMouseEnter={(e) => {
        setInternalHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setInternalHovered(false);
        onMouseLeave?.(e);
      }}
      {...props}
    >
      <motion.svg
        className="size-full overflow-visible"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        animate={controls}
        variants={{
          normal: { rotate: 0 },
          animate: {
            rotate: [0, 90],
            transition: { duration: 0.45, ease: [0.34, 1.56, 0.64, 1] },
          },
        }}
      >
        <path d="M5 12h14M12 5v14" />
      </motion.svg>
    </IconMotionFrame>
  );
}

/**
 * Animated calendar icon with a gently nudging page header.
 *
 * Feature requirements & motion behaviors:
 * - **Binder Dip**: On hover loop, the twin binder rings above the frame dip down 1.5px and
 *   rebound (`y: [0, 1.5, 0]`) with `easeOut` over 0.45s, suggesting a page being flipped open.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses `overflow-visible` on the SVG and wrapper so ring dips never clip at the viewport edge.
 * - Geometry matches Lucide's `calendar` glyph, allowing a drop-in swap wherever a static
 *   calendar icon denotes planning surfaces (landing feature cards, feature pills).
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated calendar SVG in the shared SVG-only motion frame.
 */
export function AnimatedCalendar({
  size,
  className,
  isHovered: externalHovered,
  strokeWidth = 2,
  onMouseEnter,
  onMouseLeave,
  ...props
}: AnimatedIconProps) {
  const [internalHovered, setInternalHovered] = useState(false);
  const active = externalHovered || internalHovered;
  const controls = useIconLoop(active);

  return (
    <IconMotionFrame
      className={cn("inline-flex items-center justify-center shrink-0 overflow-visible", className)}
      style={size ? { width: size, height: size } : undefined}
      onMouseEnter={(e) => {
        setInternalHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setInternalHovered(false);
        onMouseLeave?.(e);
      }}
      {...props}
    >
      <svg
        className="size-full overflow-visible"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="18" height="18" x="3" y="4" rx="2" />
        <line x1="3" x2="21" y1="10" y2="10" />
        <motion.g
          animate={controls}
          variants={{
            normal: { y: 0 },
            animate: {
              y: [0, 1.5, 0],
              transition: { duration: 0.45, ease: "easeOut" },
            },
          }}
        >
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="16" x2="16" y1="2" y2="6" />
        </motion.g>
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated clock icon with a spinning pair of hands.
 *
 * Feature requirements & motion behaviors:
 * - **Hands Sweep**: On hover loop, the clock hands rotate a full extra turn (`[0, 360]`) over
 *   0.9s with `easeInOut`, suggesting time passing quickly while scheduling runs ahead.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses `overflow-visible` so the rotating hand group never clips at the viewport edge.
 * - Geometry matches Lucide's `clock` glyph, allowing a drop-in swap wherever a static clock
 *   denotes scheduling surfaces (landing feature cards, delivery steps).
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated clock SVG in the shared SVG-only motion frame.
 */
export function AnimatedClock({
  size,
  className,
  isHovered: externalHovered,
  strokeWidth = 2,
  onMouseEnter,
  onMouseLeave,
  ...props
}: AnimatedIconProps) {
  const [internalHovered, setInternalHovered] = useState(false);
  const active = externalHovered || internalHovered;
  const controls = useIconLoop(active);

  return (
    <IconMotionFrame
      className={cn("inline-flex items-center justify-center shrink-0 overflow-visible", className)}
      style={size ? { width: size, height: size } : undefined}
      onMouseEnter={(e) => {
        setInternalHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setInternalHovered(false);
        onMouseLeave?.(e);
      }}
      {...props}
    >
      <svg
        className="size-full overflow-visible"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <motion.g
          animate={controls}
          variants={{
            normal: { rotate: 0 },
            animate: {
              rotate: [0, 360],
              transition: { duration: 0.9, ease: "easeInOut" },
            },
          }}
          style={{ originX: "12px", originY: "12px" }}
        >
          <polyline points="12 6 12 12 16 14" />
        </motion.g>
      </svg>
    </IconMotionFrame>
  );
}
