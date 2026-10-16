import React, { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { TopToolbarLabel } from "@/components/layout/top-toolbar";
import { cn } from "@meltiply/ui/utils";

export interface TopToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  isActive?: boolean;
  width?: "w-36" | "w-40" | "w-44";
  icon?: ReactNode;
}

/**
 * Canonical filter trigger button with fixed dimensions and morphing text typography.
 *
 * Enforces rigid width (`w-36`, `w-40`, `w-44`) and height (`h-8 py-0`) across routes,
 * ensuring no layout shifts, border scaling, or bounding-box distortions occur during
 * transitions. Only the internal text label morphs via `TopToolbarLabel`.
 *
 * @param props.label - Visible filter label crossfaded on change.
 * @param props.isActive - Whether the filter holds a non-default selection.
 * @param props.width - Preset fixed width class; defaults to `'w-36'`.
 * @param props.icon - Optional leading icon element (e.g. calendar or sort arrows).
 * @param props.className - Optional extra utility classes (e.g. `'capitalize'`).
 * @returns Standardized toolbar button element adhering to the Beautiful UI tokens.
 */
export const TopToolbarButton = React.forwardRef<HTMLButtonElement, TopToolbarButtonProps>(
  ({ label, isActive = false, width = "w-36", icon, className, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          "h-8 py-0 justify-between rounded-chip border border-line bg-page px-2.5 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink shadow-hairline gap-1.5 transition-colors duration-200 focus:outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0 inline-flex items-center",
          width,
          isActive && "border-line-strong text-ink font-semibold bg-surface shadow-sm",
          className,
        )}
        {...props}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="truncate text-left min-w-0 flex-1">
            <TopToolbarLabel label={label} />
          </span>
        </div>
        <ChevronDown className="size-3.5 text-ink-3 shrink-0" />
      </Button>
    );
  },
);
TopToolbarButton.displayName = "TopToolbarButton";
