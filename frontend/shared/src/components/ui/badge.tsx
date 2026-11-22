import * as React from "react";
import { cn } from "@meltiply/ui/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "outline";
}

const badgeVariants: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
  outline: "text-foreground border-border",
};

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
