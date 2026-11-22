import * as React from "react";
import { cn } from "@meltiply/ui/utils";
import { useForwardedRef } from "../primitives/use-forwarded-ref";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoGrow?: boolean;
}

function fitToContent(element: HTMLTextAreaElement): void {
  const styles = getComputedStyle(element);
  const minimum = Number.parseFloat(styles.minHeight) || 0;
  const maximum =
    styles.maxHeight === "none" ? Number.POSITIVE_INFINITY : Number.parseFloat(styles.maxHeight);
  element.style.height = "auto";
  const borders = element.offsetHeight - element.clientHeight;
  element.style.height = `${Math.min(Math.max(element.scrollHeight + borders, minimum), maximum)}px`;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoGrow = false, onInput, ...props }, ref) => {
    const [elementRef, assignRef] = useForwardedRef(ref);

    React.useLayoutEffect(() => {
      if (autoGrow && elementRef.current) fitToContent(elementRef.current);
    }, [autoGrow, elementRef, props.value]);

    return (
      <textarea
        className={cn(
          "flex min-h-[80px] min-w-0 w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm pointer-coarse:text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
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
