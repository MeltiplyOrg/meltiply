import type { ComponentProps } from "react";
import { domAnimation, LazyMotion } from "motion/react";

/**
 * Supplies SVG/interaction features without shipping Motion's unused drag/layout
 * bundle to landing islands. The existing div, DOM props, children and React 19
 * ref are preserved, so app and native-control adapters retain identical geometry.
 * A native data hook supplies standalone geometry without requiring Tailwind.
 */
export function IconMotionFrame(props: ComponentProps<"div">) {
  return (
    <LazyMotion features={domAnimation} strict>
      <div {...props} data-animated-icon="" />
    </LazyMotion>
  );
}
