import { m as motion } from "motion/react";
import type { AnimatedIconProps } from "./types";
import { IconMotionFrame } from "./icon-motion-frame";

/** Plus SVG with a quarter-turn loop; stroke defaults to 2 and IconMotionFrame owns interaction. */
export function AnimatedPlus({ strokeWidth = 2, ...props }: AnimatedIconProps) {
  return (
    <IconMotionFrame {...props}>
      {(controls) => (
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
      )}
    </IconMotionFrame>
  );
}

/** Calendar SVG with dipping binder rings; stroke defaults to 2 and overflow stays unclipped. */
export function AnimatedCalendar({ strokeWidth = 2, ...props }: AnimatedIconProps) {
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
      )}
    </IconMotionFrame>
  );
}

/** Clock SVG with one full hand rotation; stroke defaults to 2 and IconMotionFrame owns interaction. */
export function AnimatedClock({ strokeWidth = 2, ...props }: AnimatedIconProps) {
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
      )}
    </IconMotionFrame>
  );
}
