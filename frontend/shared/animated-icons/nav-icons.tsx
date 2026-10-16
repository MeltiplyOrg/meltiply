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
 * Animated AI Studio sparkles icon with radiant primary star rotation and blinking secondary satellites.
 *
 * Feature requirements & motion behaviors:
 * - **Radiant Center & Twinkle**: On hover loop, rotates and scales the primary sparkle (`scale: [1, 1.14, 1]`, `rotate: [0, 15, -12, 6, 0]`)
 *   while secondary satellite stars blink with staggered opacity drops (`opacity: [1, 0.2, 1]`) and scale pulses over 0.8s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Renders with `overflow-visible` so scaled sparkles and rotating satellites do not clip outside the viewBox.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated AI sparkles SVG in the shared SVG-only motion frame.
 */
export function AnimatedSparkles({
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
          d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
          animate={controls}
          variants={{
            normal: { scale: 1, rotate: 0 },
            animate: {
              scale: [1, 1.14, 0.96, 1.05, 1],
              rotate: [0, 15, -12, 6, 0],
              transition: { duration: 0.8, ease: "easeInOut" },
            },
          }}
          style={{ originX: "11px", originY: "11px" }}
        />
        <motion.path
          d="M20 3v4M22 5h-4"
          animate={controls}
          variants={{
            normal: { opacity: 1, scale: 1 },
            animate: {
              opacity: [1, 0.2, 1, 0.3, 1],
              scale: [1, 1.3, 0.9, 1.2, 1],
              transition: { duration: 0.8, delay: 0.08 },
            },
          }}
          style={{ originX: "20px", originY: "5px" }}
        />
        <motion.path
          d="M4 17v2M5 18H3"
          animate={controls}
          variants={{
            normal: { opacity: 1, scale: 1 },
            animate: {
              opacity: [1, 0.3, 1, 0.2, 1],
              scale: [1, 0.8, 1.25, 0.95, 1],
              transition: { duration: 0.8, delay: 0.16 },
            },
          }}
          style={{ originX: "4px", originY: "18px" }}
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
 * Animated analytics bar chart icon with staggered vertical column growth.
 *
 * Feature requirements & motion behaviors:
 * - **Staggered Bar Growth**: On hover loop, grows each chart column along its Y-origin (16px)
 *   (`scaleY: [1, 1.4, 0.9, 1]`) with 0.08s and 0.16s staggered delays over 0.55s to convey performance momentum.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Renders with `overflow-visible` on both container and SVG to ensure column heights expand cleanly without edge clipping.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated bar chart SVG in the shared SVG-only motion frame.
 */
export function AnimatedBarChart({
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
        <path d="M3 3v16a2 2 0 0 0 2 2h16" />
        <motion.path
          d="M7 16v-4"
          animate={controls}
          variants={{
            normal: { scaleY: 1 },
            animate: {
              scaleY: [1, 1.45, 0.9, 1],
              transition: { duration: 0.55, ease: "easeInOut" },
            },
          }}
          style={{ originY: "16px" }}
        />
        <motion.path
          d="M12 16V9"
          animate={controls}
          variants={{
            normal: { scaleY: 1 },
            animate: {
              scaleY: [1, 1.35, 0.92, 1],
              transition: { duration: 0.55, delay: 0.08, ease: "easeInOut" },
            },
          }}
          style={{ originY: "16px" }}
        />
        <motion.path
          d="M17 16v-7"
          animate={controls}
          variants={{
            normal: { scaleY: 1 },
            animate: {
              scaleY: [1, 1.4, 0.9, 1],
              transition: { duration: 0.55, delay: 0.16, ease: "easeInOut" },
            },
          }}
          style={{ originY: "16px" }}
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
 * Animated integrations puzzle icon with tactile snap-and-wiggle engagement.
 *
 * Feature requirements & motion behaviors:
 * - **Snap & Wiggle**: On hover loop, rotates the puzzle piece back-and-forth (`[-9°, +9°]`)
 *   combined with an elastic pop scale (`scale: [1, 1.08, 0.98, 1]`) using spring overshoot easing over 0.65s.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Employs `overflow-visible` on the SVG and wrapper container to prevent spring-overshoot rotation and scale clipping.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated puzzle SVG in the shared SVG-only motion frame.
 */
export function AnimatedPuzzle({
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
          d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"
          animate={controls}
          variants={{
            normal: { rotate: 0, scale: 1 },
            animate: {
              rotate: [0, -9, 9, -5, 5, 0],
              scale: [1, 1.08, 0.98, 1],
              transition: { duration: 0.65, ease: [0.34, 1.56, 0.64, 1] },
            },
          }}
          style={{ originX: "12px", originY: "12px" }}
        />
      </svg>
    </IconMotionFrame>
  );
}

/**
 * Animated settings gear icon with precision mechanical rotation.
 *
 * Feature requirements & motion behaviors:
 * - **90° Precision Index**: On hover loop, indexes the gear wheel 90° clockwise using snappy
 *   spring physics (`[0.34, 1.4, 0.64, 1]`) over 0.5s to communicate mechanical responsiveness.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Keeps SVG and container overflow visible (`overflow-visible`) so rotating gear teeth remain intact throughout motion.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated settings gear SVG in the shared SVG-only motion frame.
 */
export function AnimatedSettings({
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
            transition: { duration: 0.5, ease: [0.34, 1.4, 0.64, 1] },
          },
        }}
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </motion.svg>
    </IconMotionFrame>
  );
}

/**
 * Animated overview layout grid icon with clockwise pulsating square cell wave.
 *
 * Feature requirements & motion behaviors:
 * - **Clockwise Wave Pulse**: On hover loop, articulates the four quadrant grid rectangles in sequence
 *   with scale expansion (`[1, 1.2, 1]`) and staggered delays (0.07s intervals) over 0.6s to communicate
 *   content aggregation and live workspace activity.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Utilises unclipped SVG overflow (`overflow-visible`) to prevent quadrant scale pulses from clipping along icon boundaries.
 *
 * @param props - Animated icon properties including `size`, `strokeWidth`, `className`, and hover event handlers.
 * @returns Animated 4-cell layout grid SVG in the shared SVG-only motion frame.
 */
export function AnimatedLayoutGrid({
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
        <motion.rect
          width="7"
          height="7"
          x="3"
          y="3"
          rx="1"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.2, 1],
              transition: {
                duration: 0.6,
                delay: 0,
                ease: [0.34, 1.56, 0.64, 1],
              },
            },
          }}
          style={{ originX: "6.5px", originY: "6.5px" }}
        />
        <motion.rect
          width="7"
          height="7"
          x="14"
          y="3"
          rx="1"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.2, 1],
              transition: {
                duration: 0.6,
                delay: 0.08,
                ease: [0.34, 1.56, 0.64, 1],
              },
            },
          }}
          style={{ originX: "17.5px", originY: "6.5px" }}
        />
        <motion.rect
          width="7"
          height="7"
          x="14"
          y="14"
          rx="1"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.2, 1],
              transition: {
                duration: 0.6,
                delay: 0.16,
                ease: [0.34, 1.56, 0.64, 1],
              },
            },
          }}
          style={{ originX: "17.5px", originY: "17.5px" }}
        />
        <motion.rect
          width="7"
          height="7"
          x="3"
          y="14"
          rx="1"
          animate={controls}
          variants={{
            normal: { scale: 1 },
            animate: {
              scale: [1, 1.2, 1],
              transition: {
                duration: 0.6,
                delay: 0.24,
                ease: [0.34, 1.56, 0.64, 1],
              },
            },
          }}
          style={{ originX: "6.5px", originY: "17.5px" }}
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
