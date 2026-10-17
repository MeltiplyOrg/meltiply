import { m as motion } from "motion/react";
import type { AnimatedIconProps } from "./types";
import { IconMotionFrame } from "./icon-motion-frame";

/** Writing-square SVG with a pen-stroke loop; stroke defaults to 2 and IconMotionFrame owns interaction. */
export function AnimatedSquarePen({ strokeWidth = 2, ...props }: AnimatedIconProps) {
  return (
    <IconMotionFrame {...props}>
      {(controls) => (
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
      )}
    </IconMotionFrame>
  );
}

/** Image SVG with a rising sun and drifting ridge; stroke defaults to 2 and overflow stays unclipped. */
export function AnimatedImage({ strokeWidth = 2, ...props }: AnimatedIconProps) {
  return (
    <IconMotionFrame {...props}>
      {(controls) => (
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
      )}
    </IconMotionFrame>
  );
}

/** Sharing-network SVG with staggered node pulses; stroke defaults to 2 and IconMotionFrame owns interaction. */
export function AnimatedShare({ strokeWidth = 2, ...props }: AnimatedIconProps) {
  return (
    <IconMotionFrame {...props}>
      {(controls) => (
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
      )}
    </IconMotionFrame>
  );
}

/** Layers SVG with independently lifted upper sheets; stroke defaults to 2 and overflow stays unclipped. */
export function AnimatedLayers({ strokeWidth = 2, ...props }: AnimatedIconProps) {
  return (
    <IconMotionFrame {...props}>
      {(controls) => (
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
      )}
    </IconMotionFrame>
  );
}
