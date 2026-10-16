import { useState } from "react";
import { m as motion, AnimatePresence } from "motion/react";
import { cn } from "../utils";
import type { AnimatedIconProps } from "./types";
import { useIconLoop } from "./use-icon-loop";
import { useMotionPreference } from "../motion-preference";
import { IconMotionFrame } from "./icon-motion-frame";

/**
 * Properties for the {@link AnimatedCollapseToggle} component.
 *
 * @property collapsed - Collapsed state of the sidebar or drawer; controls arrow orientation and container layout.
 */
export interface AnimatedCollapseToggleProps extends Omit<AnimatedIconProps, "children"> {
  collapsed: boolean;
}

/**
 * Animated sidebar collapse/expand toggle icon.
 *
 * Feature requirements & motion behaviors:
 * - **Collapse State Morph**: Renders a panel boundary with a directional chevron. When `collapsed` changes,
 *   the chevron flips 180° via spring rotation (`collapsed ? 180 : 0`).
 * - **Hover Feedback**: On hover, the directional chevron slides horizontally (`x: [0, -3, 0]` when expanded, `x: [0, 3, 0]` when collapsed)
 *   with a spring bounce to visually signal the collapsible collapse/expand direction.
 * - Under the shared low-motion preference, the chevron orientation flips instantly with no slide morph or hover nudges.
 * - Supports internal hover tracking and external `isHovered` prop synchronisation via {@link useIconLoop}.
 * - Employs `overflow-visible` so horizontal chevron nudge transitions never clip along the container edges.
 *
 * @param props - Component properties including `collapsed`, dimensions (`size`, `strokeWidth`), custom styles (`className`), and hover events.
 * @returns Animated collapse-toggle SVG in the shared SVG-only motion frame.
 */
export function AnimatedCollapseToggle({
  collapsed,
  size,
  className,
  isHovered: externalHovered,
  strokeWidth = 2,
  onMouseEnter,
  onMouseLeave,
  ...props
}: AnimatedCollapseToggleProps) {
  const [internalHovered, setInternalHovered] = useState(false);
  const active = externalHovered || internalHovered;
  const controls = useIconLoop(active);
  const { lowMotion } = useMotionPreference();
  // Low motion flips the chevron instantly: no slide morph, no exit travel.
  const chevronTransition = lowMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: "easeOut" as const };

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
        {/* Outer panel window */}
        <rect height="18" rx="2" width="18" x="3" y="3" />
        {/* Sidebar partition line */}
        <path d="M9 3v18" />
        {/* Animated Chevron: smooth morph between left (collapse) and right (expand) + full cycle hover nudge */}
        <AnimatePresence mode="wait" initial={false}>
          {collapsed ? (
            // Expand chevron (points right, expands sidebar)
            <motion.path
              key="expand"
              d="m14 9 3 3-3 3"
              initial={lowMotion ? false : { opacity: 0, x: -2 }}
              animate={controls}
              variants={{
                normal: { opacity: 1, x: 0 },
                animate: {
                  opacity: 1,
                  x: [0, 2.5, 0],
                  transition: { duration: 0.5, ease: "easeInOut" },
                },
              }}
              exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: 2 }}
              transition={chevronTransition}
            />
          ) : (
            // Collapse chevron (points left, collapses sidebar)
            <motion.path
              key="collapse"
              d="m16 15-3-3 3-3"
              initial={lowMotion ? false : { opacity: 0, x: 2 }}
              animate={controls}
              variants={{
                normal: { opacity: 1, x: 0 },
                animate: {
                  opacity: 1,
                  x: [0, -2.5, 0],
                  transition: { duration: 0.5, ease: "easeInOut" },
                },
              }}
              exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -2 }}
              transition={chevronTransition}
            />
          )}
        </AnimatePresence>
      </svg>
    </IconMotionFrame>
  );
}
