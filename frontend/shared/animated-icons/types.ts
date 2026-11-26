import type { HTMLAttributes, Ref } from "react";

export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  strokeWidth?: number;
  className?: string;
  isHovered?: boolean;
  ref?: Ref<HTMLDivElement>;
}
