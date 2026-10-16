import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Props for configuring the Badge component.
 */
export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Visual style variant representing status, emphasis, or severity.
   * Defaults to `'default'`.
   */
  variant?: "default" | "secondary" | "destructive" | "outline";
}

/**
 * Class name mapping for supported badge visual variants using theme design tokens.
 */
const badgeVariants: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
  secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
  destructive:
    "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
  outline: "text-foreground border-border",
};

/**
 * Compact status indicator and metadata label component.
 *
 * Renders an inline pill badge supporting semantic variants for primary labels,
 * secondary descriptors, destructive alerts, and subtle outlines.
 *
 * @param className - Additional CSS class names merged into the badge container.
 * @param variant - Visual presentation variant determining color tokens and background fill.
 * @param props - Standard HTML div element attributes forwarded to the container.
 *
 * @example
 * ```tsx
 * <Badge variant="destructive">Failed</Badge>
 * <Badge variant="secondary">Draft</Badge>
 * ```
 */
export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  );
}
