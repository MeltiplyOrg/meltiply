import React, { useEffect, useState, useRef, useCallback } from "react";
import { motion } from "motion/react";
import { cn } from "@meltiply/ui/utils";

/**
 * Configuration properties for the `SlidingMenuHighlight` component.
 */
export interface SlidingMenuHighlightProps {
  /** React ref attached to the scrollable or portalled menu container whose items are tracked. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** CSS selector identifying selectable items within the container. Defaults to `[data-dropdown-item]`. */
  itemSelector?: string;
  /** Optional additional CSS class names applied to the motion highlight element. */
  className?: string;
}

/**
 * Coordinate and dimension bounding box for positioning the sliding highlight pill.
 */
interface TargetBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Renders a sliding highlight pill behind active items inside dropdown menus and selects.
 *
 * Radix Select marks an item `data-highlighted` the moment the popover opens
 * (the selected option, or the first one), which must not paint the pill — the
 * highlight only appears after a real `pointermove` inside the menu or a
 * `keydown` while the menu owns focus. Once interaction starts, attribute
 * changes drive the pill so keyboard and pointer highlights both track; the
 * first paint snaps without motion, then springs between items. Repeated
 * measurements of the same item are ignored so Radix Popper repositioning
 * during menu entry cannot shake the overlay.
 *
 * @param props - Target container ref, custom item selector, and optional styling overrides.
 * @returns An absolute motion-animated highlight element rendered behind menu items.
 */
export function SlidingMenuHighlight({
  containerRef,
  itemSelector = "[data-dropdown-item]",
  className,
}: SlidingMenuHighlightProps) {
  const [targetBox, setTargetBox] = useState<TargetBox | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const isVisibleRef = useRef(false);
  const [isFirstEntry, setIsFirstEntry] = useState(true);
  const lastItemRef = useRef<HTMLElement | null>(null);
  // Radix applies `data-highlighted` on open before any user input; this gate
  // keeps that initial state from painting the pill until a pointer move or
  // keydown proves real interaction.
  const hasInteractedRef = useRef(false);

  const updateBox = useCallback(
    (item: HTMLElement | null) => {
      const container = containerRef.current;
      if (!container || !item) {
        lastItemRef.current = null;
        isVisibleRef.current = false;
        setIsFirstEntry(true);
        setIsVisible(false);
        return;
      }

      if (lastItemRef.current === item && isVisibleRef.current) {
        return;
      }

      const shouldAnimate = lastItemRef.current !== null;
      lastItemRef.current = item;
      isVisibleRef.current = true;
      setIsFirstEntry(!shouldAnimate);

      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const nextBox = {
        top: itemRect.top - containerRect.top + container.scrollTop,
        left: itemRect.left - containerRect.left + container.scrollLeft,
        width: itemRect.width,
        height: itemRect.height,
      };

      setTargetBox((prev) => {
        if (
          prev &&
          prev.top === nextBox.top &&
          prev.left === nextBox.left &&
          prev.width === nextBox.width &&
          prev.height === nextBox.height
        ) {
          return prev;
        }
        return nextBox;
      });
      setIsVisible(true);
    },
    [containerRef],
  );
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const findItemUnderPointer = (clientX: number, clientY: number): HTMLElement | null => {
      const el = document.elementFromPoint(clientX, clientY);
      return el?.closest<HTMLElement>(itemSelector) ?? null;
    };

    const handlePointerMove = (e: PointerEvent) => {
      hasInteractedRef.current = true;
      const item = findItemUnderPointer(e.clientX, e.clientY);
      if (item && container.contains(item)) {
        updateBox(item);
      }
    };

    // Radix moves focus into the menu content (a popper sibling of the tracked
    // viewport), so keydown is observed at document level and scoped back to
    // this menu's popper wrapper — or the content parent when no wrapper exists.
    const menuRoot =
      container.closest<HTMLElement>("[data-radix-popper-content-wrapper]") ??
      container.parentElement ??
      container;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof Node && menuRoot.contains(e.target)) {
        hasInteractedRef.current = true;
      }
    };

    const handlePointerLeave = () => {
      lastItemRef.current = null;
      isVisibleRef.current = false;
      hasInteractedRef.current = false;
      setIsFirstEntry(true);
      setIsVisible(false);
    };

    // Watch for Radix attribute changes (e.g. data-highlighted when using keyboard or mouse).
    // Mutations are ignored until the first real interaction so the item Radix
    // pre-highlights on open never paints as hovered.
    const observer = new MutationObserver(() => {
      if (!hasInteractedRef.current) return;
      const highlighted = container.querySelector<HTMLElement>(
        `${itemSelector}[data-highlighted], [data-highlighted]`,
      );
      if (highlighted && container.contains(highlighted)) {
        updateBox(highlighted);
      } else {
        const anyHovered = container.querySelector<HTMLElement>(`${itemSelector}:hover`);
        if (anyHovered) {
          updateBox(anyHovered);
        }
      }
    });

    observer.observe(container, {
      attributes: true,
      attributeFilter: ["data-highlighted"],
      subtree: true,
    });

    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerleave", handlePointerLeave);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      observer.disconnect();
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [containerRef, itemSelector, updateBox]);

  return (
    <motion.div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-0 rounded-control border border-line-soft shadow-xs",
        className,
      )}
      style={{
        backgroundColor: "var(--hover)",
        borderColor: "var(--line-soft)",
      }}
      initial={false}
      animate={{
        top: targetBox?.top ?? 0,
        left: targetBox?.left ?? 0,
        width: targetBox?.width ?? 0,
        height: targetBox?.height ?? 0,
        opacity: isVisible && targetBox ? 1 : 0,
        scale: 1,
      }}
      transition={{
        top: isFirstEntry
          ? { duration: 0 }
          : { type: "spring", stiffness: 450, damping: 32, mass: 0.8 },
        left: isFirstEntry
          ? { duration: 0 }
          : { type: "spring", stiffness: 450, damping: 32, mass: 0.8 },
        width: isFirstEntry
          ? { duration: 0 }
          : { type: "spring", stiffness: 450, damping: 32, mass: 0.8 },
        height: isFirstEntry
          ? { duration: 0 }
          : { type: "spring", stiffness: 450, damping: 32, mass: 0.8 },
        opacity: { duration: 0.14, ease: "easeOut" },
      }}
    />
  );
}
