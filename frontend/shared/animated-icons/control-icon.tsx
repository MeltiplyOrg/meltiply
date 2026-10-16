import { useEffect, useRef, useState, type ComponentType, type ReactElement } from "react";

import type { AnimatedIconProps } from "./types";

/**
 * Properties for the {@link ControlIcon} adapter.
 *
 * @property icon - Animated icon component rendered inside the wrapper.
 * @property control - CSS selector resolved via `closest()` from the icon's DOM node; defaults to
 *   common interactive containers. Pointer and keyboard focus on that control drive `isHovered`.
 * @property iconProps - Props forwarded to the icon (`size`, `strokeWidth`, `className`, ARIA).
 */
export interface ControlIconProps {
  icon: ComponentType<AnimatedIconProps>;
  control?: string;
  iconProps?: AnimatedIconProps;
}

const defaultControlSelector = "a, button, [role='tab'], .feature-card";

/**
 * Drives an animated icon's `isHovered` state from the containing control rather than the glyph.
 *
 * Server-rendered landing markup mounts icons as provider-free islands whose parent `<a>`/`<button>`
 * is authored in Astro, so the icon cannot inherit hover through React props. This adapter resolves
 * the nearest interactive ancestor with `closest()` after mount and combines
 * pointer and keyboard focus, so leaving with the pointer does not cancel a
 * still-focused control. A first-frame check also covers interaction before
 * lazy hydration. Wrapping the icon keeps the parent's
 * semantics, labels, and focus order untouched; `useIconLoop` still gates playback on the shared
 * low-motion and ink flags, so nothing extra is needed here.
 *
 * The bound control is captured once per mount; Astro islands never reparent without remounting.
 *
 * @param props - Icon component plus optional ancestor selector and forwarded icon props.
 * @returns The animated icon element with control-bound hover state.
 */
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
