import { useState, type ReactNode } from "react";
import { domAnimation, LazyMotion, type LegacyAnimationControls } from "motion/react";
import { cn } from "../utils";
import { useIconLoop } from "./use-icon-loop";
import type { AnimatedIconProps } from "./types";

type IconMotionFrameProps = Omit<AnimatedIconProps, "children" | "strokeWidth"> & {
  children: (controls: LegacyAnimationControls) => ReactNode;
};

/**
 * Owns retained icons' shared sizing, hover forwarding, and animation loop.
 * Glyphs supply only their SVG geometry and animation variants.
 * DOM props and React 19 refs retain their existing precedence; explicit style
 * can override size. Lazy SVG features avoid shipping drag/layout machinery.
 */
export function IconMotionFrame({
  size,
  className,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  children,
  ...props
}: IconMotionFrameProps) {
  const [internalHovered, setInternalHovered] = useState(false);
  const controls = useIconLoop(Boolean(isHovered || internalHovered));

  return (
    <LazyMotion features={domAnimation} strict>
      <div
        className={cn(
          "inline-flex items-center justify-center shrink-0 overflow-visible",
          className,
        )}
        style={size ? { width: size, height: size } : undefined}
        onMouseEnter={(event) => {
          setInternalHovered(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setInternalHovered(false);
          onMouseLeave?.(event);
        }}
        {...props}
        data-animated-icon=""
      >
        {children(controls)}
      </div>
    </LazyMotion>
  );
}
