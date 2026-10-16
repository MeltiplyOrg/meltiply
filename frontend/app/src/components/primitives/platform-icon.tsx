import React from "react";
import { Share2 } from "lucide-react";
import { cn } from "@meltiply/ui/utils";

export interface PlatformIconProps {
  /** Platform identifier or provider slug, including legacy aliases and suffixes. */
  provider: string;
  /** Optional sizing classes; defaults to a 16px square. */
  className?: string;
}

const platformIdentifiers = [
  ["threads", "TH"],
  ["pinterest", "PI"],
  ["reddit", "RE"],
  ["telegram", "TG"],
  ["bluesky", "BS"],
  ["mastodon", "MA"],
  ["discord", "DI"],
  ["medium", "ME"],
  ["wordpress", "WP"],
  ["facebook", "FB"],
  ["instagram", "IG"],
  ["tiktok", "TT"],
  ["youtube", "YT"],
  ["twitter", "X"],
  ["x", "X"],
  ["linkedin", "LI"],
] as const;

/**
 * Identifies platforms with original, neutral letter badges rather than copied
 * brand marks. Case-insensitive containment preserves legacy provider suffixes
 * and the Twitter alias; unknown providers retain the generic sharing glyph.
 * Decorative, static SVGs inherit theme ink and scale with the supplied size.
 */
export const PlatformIcon = React.memo(function PlatformIcon({
  provider,
  className = "size-4",
}: PlatformIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const identifier = platformIdentifiers.find(([matcher]) => normalizedProvider.includes(matcher));
  if (!identifier) return <Share2 aria-hidden="true" className={cn(className, "text-ink-3")} />;

  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none">
      <rect
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <text
        x="12"
        y="12.5"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="system-ui, sans-serif"
        fontSize="9"
        fontWeight="650"
      >
        {identifier[1]}
      </text>
    </svg>
  );
});
