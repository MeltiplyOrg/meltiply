import * as React from "react";
import { cn } from "@meltiply/ui/utils";

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "destructive" | "info" | "warning";
}

/**
 * Accessible callout container rendering informative, warning, or destructive feedback.
 *
 * Implements the WAI-ARIA `alert` role and styles border, background, and text
 * from the semantic token ramp; warnings use orange rather than a palette-specific amber.
 *
 * @param props - Standard HTML div attributes plus optional `variant` ('default' | 'destructive' | 'info' | 'warning').
 * @returns Styled callout container element.
 */
export function Alert({ className, variant = "default", ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn(
        "relative w-full rounded-control border p-3 text-sm flex items-start gap-2.5",
        variant === "destructive"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : variant === "warning"
            ? "border-orange/30 bg-orange-tint text-orange"
            : variant === "info"
              ? "border-accent/30 bg-accent/10 text-ink"
              : "border-line bg-surface text-ink",
        className,
      )}
      {...props}
    />
  );
}
