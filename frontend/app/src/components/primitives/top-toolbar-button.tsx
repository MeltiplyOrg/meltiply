import React, { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";

export interface TopToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  isActive?: boolean;
  width?: "w-36" | "w-40" | "w-44";
  icon?: ReactNode;
}

/** Canonical named filter trigger; forwards menu refs while keeping labels and focus stable. */
export const TopToolbarButton = React.forwardRef<HTMLButtonElement, TopToolbarButtonProps>(
  ({ label, isActive = false, width, icon, className, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className={cn("justify-between", width, isActive && "border-accent", className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <ChevronDown className="size-3.5 text-ink-3" />
    </Button>
  ),
);
TopToolbarButton.displayName = "TopToolbarButton";
