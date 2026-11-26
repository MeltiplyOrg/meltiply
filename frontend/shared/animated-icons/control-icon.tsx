import { useEffect, useRef, useState, type ComponentType, type ReactElement } from "react";

import type { AnimatedIconProps } from "./types";

export interface ControlIconProps {
  icon: ComponentType<AnimatedIconProps>;
  control?: string;
  iconProps?: AnimatedIconProps;
}

const defaultControlSelector = "a, button, [role='tab'], .feature-card";

export function ControlIcon({
  icon: Icon,
  control = defaultControlSelector,
  iconProps,
}: ControlIconProps): ReactElement {
  const [controlHovered, setControlHovered] = useState(false);
  const iconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = iconRef.current?.closest(control);
    if (!target) return;

    let hovered = target.matches(":hover");
    let focused = target.contains(document.activeElement);
    const update = () => setControlHovered(hovered || focused);
    const onEnter = (event: Event) => {
      if (event.type === "focusin") focused = true;
      else hovered = true;
      update();
    };
    const onLeave = (event: Event) => {
      const related = (event as MouseEvent).relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      if (event.type === "focusout") focused = false;
      else hovered = false;
      update();
    };
    const frame = requestAnimationFrame(update);
    target.addEventListener("mouseover", onEnter);
    target.addEventListener("mouseout", onLeave);
    target.addEventListener("focusin", onEnter);
    target.addEventListener("focusout", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("mouseover", onEnter);
      target.removeEventListener("mouseout", onLeave);
      target.removeEventListener("focusin", onEnter);
      target.removeEventListener("focusout", onLeave);
    };
  }, [control]);

  return <Icon ref={iconRef} isHovered={controlHovered} {...iconProps} />;
}
