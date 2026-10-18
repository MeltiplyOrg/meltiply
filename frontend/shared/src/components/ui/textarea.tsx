import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Properties for the styled multiline text input component, extending standard HTML textarea attributes.
 */
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * Grow the element with its own content instead of scrolling inside one fixed
   * box. Callers keep owning both bounds through classes: the measured height is
   * clamped by the element's computed `min-height` and `max-height`, so the field
   * stops growing and scrolls internally once the content passes the maximum.
   */
  autoGrow?: boolean;
}

/**
 * Styled multiline textarea component with unified border, background, focus ring, and disabled styles.
 *
 * Enforces a minimum height (80px), full width, and responsive text sizing, forwarding refs to the
 * underlying `<textarea>` element for form management (e.g. react-hook-form) and auto-resizing.
 *
 * With `autoGrow` the element writes only its own `height` (the documented
 * dynamic-geometry seam) after every commit and on input, because the browser
 * offers no stylesheet form of content sizing. The height is never transitioned,
 * so typing resizes the box immediately rather than animating layout.
 *
 * @param props - Standard HTML textarea attributes (`value`, `onChange`, `placeholder`, `rows`, etc.)
 *                and forwarded element ref.
 * @returns The styled textarea element.
 *
 * @example
 * ```tsx
 * <Textarea placeholder="Type your post caption here..." rows={4} />
 * ```
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoGrow = false, onInput, ...props }, ref) => {
    const elementRef = React.useRef<HTMLTextAreaElement | null>(null);
    const assignRef = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        elementRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    /** Fits the box to its content between the caller's two computed bounds. */
    const fitToContent = React.useCallback((element: HTMLTextAreaElement | null) => {
      if (element === null) return;
      const styles = getComputedStyle(element);
      const minimum = Number.parseFloat(styles.minHeight) || 0;
      const maximum =
        styles.maxHeight === "none"
          ? Number.POSITIVE_INFINITY
          : Number.parseFloat(styles.maxHeight);
      // Collapse first so a shrinking value can pull the box back down.
      element.style.height = "auto";
      // `scrollHeight` measures the content box while the written `height` is
      // border-box, so the borders come back or every field keeps a hair of
      // hidden scroll under its last line.
      const borders = element.offsetHeight - element.clientHeight;
      const fitted = Math.min(Math.max(element.scrollHeight + borders, minimum), maximum);
      element.style.height = `${fitted}px`;
    }, []);

    // Parent-driven values (recovered draft, switched override, loaded Post)
    // change without an input event, so the box is refitted after every commit.
    React.useLayoutEffect(() => {
      if (autoGrow) fitToContent(elementRef.current);
    });

    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={assignRef}
        onInput={(event: React.InputEvent<HTMLTextAreaElement>) => {
          if (autoGrow) fitToContent(event.currentTarget);
          onInput?.(event);
        }}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
