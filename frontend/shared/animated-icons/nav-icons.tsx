import { useState } from "react";
import { m as motion } from "motion/react";
import { cn } from "../utils";
import type { AnimatedIconProps } from "./types";
import { useIconLoop } from "./use-icon-loop";
import { IconMotionFrame } from "./icon-motion-frame";

/**
 * Animated post composer icon featuring a writing square and dynamic pen stroke motion.
 *
 * Feature requirements & motion behaviors:
 * - **Pen Stroke Simulation**: On hover loop, articulates the pen path across rotational (`[-4°, +4°]`)
 *   and translational offsets (`x: [-1, +1.5px]`, `y: [-1, +1.5px]`) to mimic a handwriting motion over 0.65s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses unclipped SVG overflow (`overflow-visible`) to preserve dynamic pen articulation strokes without edge truncation.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated composer SVG in the shared SVG-only motion frame.
 */
export function AnimatedSquarePen({
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
        <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <motion.path
          d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
          animate={controls}
          variants={{
            normal: { rotate: 0, x: 0, y: 0 },
            animate: {
              rotate: [0, -4, 4, -2, 2, 0],
              x: [0, -1, 1.5, -0.5, 0],
              y: [0, 1.5, -1, 0.5, 0],
              transition: { duration: 0.65, ease: "easeInOut" },
            },
          }}
        />
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated media library icon with rising sun and rolling landscape horizon.
 *
 * Feature requirements & motion behaviors:
 * - **Floating Sun & Hill Drift**: On hover loop, elevates the sun circle (`y: -2px`, `scale: 1.2`)
 *   while gently undulating the mountain ridge line (`y: [0, 1, -0.5, 0]`) over 0.65s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Retains unclipped SVG overflow (`overflow-visible`) to allow subtle landscape undulation without boundary clipping.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated media image SVG in the shared SVG-only motion frame.
 */
export function AnimatedImage({
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
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <motion.circle
          cx="9"
          cy="9"
          r="2"
          animate={controls}
          variants={{
            normal: { y: 0, scale: 1 },
            animate: {
              y: [0, -2, 0],
              scale: [1, 1.2, 1],
              transition: { duration: 0.65, ease: "easeInOut" },
            },
          }}
          style={{ originX: "9px", originY: "9px" }}
        />
        <motion.path
          d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
          animate={controls}
          variants={{
            normal: { y: 0 },
            animate: {
              y: [0, 1, -0.5, 0],
              transition: { duration: 0.65, delay: 0.05, ease: "easeInOut" },
            },
          }}
        />
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated social channels share network icon with pulsing nodes and connector tension.
 *
 * Feature requirements & motion behaviors:
 * - **Network Pulse**: On hover loop, pulses the 3 channel node circles (`scale: 1.3x`) alongside
 *   translucent opacity flickers (`opacity: [1, 0.35, 1]`) across the connecting link lines over 0.55s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Uses unclipped SVG overflow (`overflow-visible`) so pulsing node circles never clip along the outer perimeter.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated share network SVG in the shared SVG-only motion frame.
 */
export function AnimatedShare({
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
        <motion.circle
          cx="18"
          cy="5"
          r="3"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.28, 1],
              transition: { duration: 0.55, delay: 0.08, ease: "easeInOut" },
            },
          }}
          style={{ originX: "18px", originY: "5px" }}
        />
        <motion.circle
          cx="6"
          cy="12"
          r="3"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.3, 1],
              transition: { duration: 0.55, ease: "easeInOut" },
            },
          }}
          style={{ originX: "6px", originY: "12px" }}
        />
        <motion.circle
          cx="18"
          cy="19"
          r="3"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.28, 1],
              transition: { duration: 0.55, delay: 0.12, ease: "easeInOut" },
            },
          }}
          style={{ originX: "18px", originY: "19px" }}
        />
        <motion.line
          x1="8.59"
          y1="13.51"
          x2="15.42"
          y2="17.49"
          animate={controls}
          variants={{
            normal: { opacity: 1 },
            animate: {
              opacity: [1, 0.35, 1],
              transition: { duration: 0.55, ease: "easeInOut" },
            },
          }}
        />
        <motion.line
          x1="15.41"
          y1="6.51"
          x2="8.59"
          y2="10.49"
          animate={controls}
          variants={{
            normal: { opacity: 1 },
            animate: {
              opacity: [1, 0.35, 1],
              transition: { duration: 0.55, ease: "easeInOut" },
            },
          }}
        />
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated queue layers icon with tactile vertical stack expansion.
 *
 * Feature requirements & motion behaviors:
 * - **Stack Accordion Motion**: On hover loop, vertically lifts the upper layer (`y: [0, -2.8, 0]`)
 *   and middle layer (`y: [0, -1.4, 0]`) using overshoot spring physics over 0.65s to represent queued items.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Employs `overflow-visible` on the SVG canvas and wrapper to ensure the upper lifted layer and overshoot spring peaks
 *   never get their top edge or corner vertices clipped by the 24x24 viewport boundary.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated layers SVG in the shared SVG-only motion frame.
 */
export function AnimatedLayers({
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
          d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"
          animate={controls}
          variants={{
            normal: { y: 0 },
            animate: {
              y: [0, -2.8, 0],
              transition: { duration: 0.65, ease: [0.34, 1.56, 0.64, 1] },
            },
          }}
        />
        <motion.path
          d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"
          animate={controls}
          variants={{
            normal: { y: 0 },
            animate: {
              y: [0, -1.4, 0],
              transition: {
                duration: 0.65,
                delay: 0.08,
                ease: [0.34, 1.56, 0.64, 1],
              },
            },
          }}
        />
        <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      </svg>
    </IconMotionFrame>
  );
}
