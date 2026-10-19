import React from "react";
import { cn } from "@meltiply/ui/utils";

/** Supported semantic color themes for status indicators. */
export type StatusPillTone = "green" | "orange" | "red" | "accent" | "neutral";

const toneClasses: Record<StatusPillTone, string> = {
  green: "bg-green-tint text-green",
  orange: "bg-orange-tint text-orange",
  red: "bg-red-tint text-red",
  accent: "bg-accent-tint text-accent-ink",
  neutral: "bg-inset text-ink-2",
};

const dotColors: Record<StatusPillTone, string> = {
  green: "bg-green",
  orange: "bg-orange",
  red: "bg-red",
  accent: "bg-accent",
  neutral: "bg-ink-3",
};

/**
 * Compact badge component with semantic color styling and an optional status dot.
 *
 * Visually communicates status or categorical state (e.g., success, warning, error, active)
 * through predefined tone themes with balanced background tints, text ink colors, and dot accents.
 *
 * @param props.tone - Semantic color theme (defaults to `'neutral'`)
 * @param props.variant - `badge` for compact tinted badges; `plain` for flat Tasks metadata.
 * @param props.children - Label content to display inside the pill
 * @param props.dot - Whether to display the 6px colored indicator dot (defaults to `true`)
 * @param props.className - Optional classes to merge into the pill container
 *
 * @example
 * <StatusPill tone="green">Published</StatusPill>
 * <StatusPill tone="red" dot={false}>Failed</StatusPill>
 */
export function StatusPill({
  tone = "neutral",
  children,
  dot = true,
  variant = "badge",
  className = "",
}: {
  tone?: StatusPillTone;
  children: React.ReactNode;
  dot?: boolean;
  variant?: "badge" | "plain";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs leading-none",
        toneClasses[tone],
        variant === "plain"
          ? "h-auto bg-transparent p-0 font-normal"
          : "h-5 rounded-chip px-1.5 font-medium",
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 shrink-0 rounded-full", dotColors[tone])} />}
      <span>{children}</span>
    </span>
  );
}
