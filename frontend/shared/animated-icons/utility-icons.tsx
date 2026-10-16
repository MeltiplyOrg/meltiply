import { useState } from "react";
import { m as motion } from "motion/react";
import { cn } from "../utils";
import type { AnimatedIconProps } from "./types";
import { useIconLoop } from "./use-icon-loop";
import { IconMotionFrame } from "./icon-motion-frame";

/**
 * Animated search magnifying glass icon with directional search translation and tilt sweep.
 *
 * Feature requirements & motion behaviors:
 * - **Search Sweep**: On hover loop, smoothly translates across the X/Y axes (`[-1.5px, +1.5px]`)
 *   combined with an angular tilt (`[-6°, +6°]`) pivoting from the lens center (11px, 11px) over 0.55s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Keeps SVG and container overflow visible (`overflow-visible`) so directional sweep translation and tilt do not clip.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated search SVG in the shared SVG-only motion frame.
 */
export function AnimatedSearch({
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
          normal: { x: 0, y: 0, rotate: 0 },
          animate: {
            x: [0, -1.5, 1.5, -0.5, 0],
            y: [0, -1.5, 1.5, -0.5, 0],
            rotate: [0, -6, 6, 0],
            transition: { duration: 0.55, ease: "easeInOut" },
          },
        }}
        style={{ originX: "11px", originY: "11px" }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </motion.svg>
    </IconMotionFrame>
  );
}

/**
 * Animated close/dismiss 'X' icon with a crisp spring rotation and scaling pulse.
 *
 * Feature requirements & motion behaviors:
 * - **90° Spring Twist**: On hover loop, rotates 90° clockwise accompanied by a tactile pop-scale bounce
 *   (`scale: [1, 1.15, 1]`) using custom cubic bezier spring physics (`[0.34, 1.56, 0.64, 1]`) over 0.4s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Renders with `overflow-visible` so rotation and spring pop-scale bounce stay unclipped at all angles.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated dismiss SVG in the shared SVG-only motion frame.
 */
export function AnimatedX({
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
          normal: { rotate: 0, scale: 1 },
          animate: {
            rotate: [0, 90],
            scale: [1, 1.15, 1],
            transition: { duration: 0.4, ease: [0.34, 1.56, 0.64, 1] },
          },
        }}
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </motion.svg>
    </IconMotionFrame>
  );
}

/**
 * Animated dropdown chevron icon with a gentle downward nudge.
 *
 * Feature requirements & motion behaviors:
 * - **Down Nudge**: On hover loop, subtly displaces the chevron path vertically downwards by 2.5px
 *   before rebounding to resting position over 0.4s with `easeOut` easing.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses `overflow-visible` on the SVG and wrapper container to ensure vertical chevron nudges remain unclipped.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated chevron SVG in the shared SVG-only motion frame.
 */
export function AnimatedChevronDown({
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
        <motion.path
          d="m6 9 6 6 6-6"
          animate={controls}
          variants={{
            normal: { y: 0 },
            animate: {
              y: [0, 2.5, 0],
              transition: { duration: 0.4, ease: "easeOut" },
            },
          }}
        />
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated checkmark icon with pop-scale tactile confirmation.
 *
 * Feature requirements & motion behaviors:
 * - **Pop Scale Bounce**: On hover loop, scales the checkmark path (`scale: [1, 1.25, 0.95, 1]`)
 *   centered at (12px, 12px) using snappy spring easing (`[0.34, 1.56, 0.64, 1]`) over 0.45s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses unclipped SVG overflow (`overflow-visible`) to allow tactile pop-scale bounce without stroke clipping.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated check SVG in the shared SVG-only motion frame.
 */
export function AnimatedCheck({
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
        <motion.path
          d="M20 6 9 17l-5-5"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.25, 0.95, 1],
              transition: { duration: 0.45, ease: [0.34, 1.56, 0.64, 1] },
            },
          }}
          style={{ originX: "12px", originY: "12px" }}
        />
      </svg>
    </IconMotionFrame>
  );
}

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
 * Animated log out / sign out icon with arrow ejection motion.
 *
 * Feature requirements & motion behaviors:
 * - **Doorway Exit Slide**: On hover loop, slides the exit arrow rightwards (`x: [0, 3.5, 0]`) through the doorway
 *   boundary with smooth `easeInOut` interpolation over 0.5s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Employs `overflow-visible` so the ejection arrow sliding past x=24 remains fully visible without edge clipping.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated log out SVG in the shared SVG-only motion frame.
 */
export function AnimatedLogOut({
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
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <motion.g
          animate={controls}
          variants={{
            normal: { x: 0 },
            animate: {
              x: [0, 3.5, 0],
              transition: { duration: 0.5, ease: "easeInOut" },
            },
          }}
        >
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </motion.g>
      </svg>
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
