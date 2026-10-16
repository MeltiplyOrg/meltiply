import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Properties for the styled multiline text input component, extending standard HTML textarea attributes.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Styled multiline textarea component with unified border, background, focus ring, and disabled styles.
 *
 * Enforces a minimum height (80px), full width, and responsive text sizing, forwarding refs to the
 * underlying `<textarea>` element for form management (e.g. react-hook-form) and auto-resizing.
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
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";
