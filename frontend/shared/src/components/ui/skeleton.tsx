import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Renders an animated pulsing placeholder block representing loading content.
 *
 * Used across card headers, data tables, and widget layouts while asynchronous
 * resources (posts, analytics, user profiles) are fetching.
 *
 * @param props - Standard HTML div attributes; merges custom `className` (e.g., width, height, rounded variants)
 *                with default `animate-pulse rounded-md bg-muted`.
 * @returns A pulse-animated div styled with the muted design token.
 *
 * @example
 * ```tsx
 * <Skeleton className="h-4 w-32" />
 * ```
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
