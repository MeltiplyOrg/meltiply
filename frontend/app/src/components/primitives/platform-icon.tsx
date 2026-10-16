import React from "react";
import { Share2 } from "lucide-react";
import { cn } from "@meltiply/ui/utils";

export interface PlatformIconProps {
  /** Platform identifier or provider slug, including legacy aliases and suffixes. */
  provider: string;
  /** Optional sizing classes; defaults to a 16px square. */
  className?: string;
}

const platformIcons = [
  ["threads", "threads"],
  ["pinterest", "pinterest"],
  ["reddit", "reddit"],
  ["telegram", "telegram"],
  ["bluesky", "bluesky"],
  ["mastodon", "mastodon"],
  ["discord", "discord"],
  ["medium", "medium"],
  ["wordpress", "wordpress"],
  ["facebook", "facebook"],
  ["instagram", "instagram"],
  ["tiktok", "tiktok"],
  ["youtube", "youtube"],
  ["twitter", "x"],
  ["x", "x"],
  ["linkedin", "linkedin"],
] as const;

/**
 * Identifies providers with local, unmodified theSVG brand assets; case-insensitive
 * containment preserves legacy suffixes and Twitter → X. Unknown providers use
 * the sharing glyph. Decorative marks inherit caller sizing without adding focus
 * or motion. CSS follows the app's explicit theme, including theme-transition
 * snapshots: Threads/TikTok select supplied variants; black X/Medium invert on dark.
 */
export const PlatformIcon = React.memo(function PlatformIcon({
  provider,
  className = "size-4",
}: PlatformIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const icon = platformIcons.find(([matcher]) => normalizedProvider.includes(matcher));
  if (!icon) return <Share2 aria-hidden="true" className={cn(className, "text-ink-3")} />;

  const slug = icon[1];
  const themed = slug === "threads" || slug === "tiktok";
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      <img
        src={`/icons/platforms/${slug}${themed ? "-light" : ""}.svg`}
        alt=""
        draggable={false}
        className={cn(
          "size-full object-contain",
          themed && "dark:hidden",
          (slug === "x" || slug === "medium") && "dark:invert",
        )}
      />
      {themed && (
        <img
          src={`/icons/platforms/${slug}-dark.svg`}
          alt=""
          draggable={false}
          className="hidden size-full object-contain dark:block"
        />
      )}
    </span>
  );
});
