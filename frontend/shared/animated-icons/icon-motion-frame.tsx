import { useState, type ReactNode } from "react";
import { domAnimation, LazyMotion, type LegacyAnimationControls } from "motion/react";
import { cn } from "../utils";
import { useIconLoop } from "./use-icon-loop";
import { useMotionPreference } from "../motion-preference";
import type { AnimatedIconProps } from "./types";

type IconMotionFrameProps = Omit<AnimatedIconProps, "children" | "strokeWidth"> & {
  children: (controls: LegacyAnimationControls, lowMotion: boolean) => ReactNode;
};

/**
 * Owns retained icons' shared sizing, hover forwarding, and low-motion-aware loop.
 * Glyphs supply only SVG geometry/variants and use the supplied low-motion state
 * for immediate transitions; the loop also stops and resets when policy changes.
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
  const { lowMotion } = useMotionPreference();
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
        {children(controls, lowMotion)}
      </div>
    </LazyMotion>
  );
}
