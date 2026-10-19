import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { cn } from "@meltiply/ui/utils";

/** Derives up to two uppercase initials; blank names use a neutral avatar fallback. */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Account identity shared by the channel directory and composer destinations.
 * Uses only the supplied account picture; missing or failed images show initials,
 * never a provider logo. The small labelled badge identifies the provider separately.
 * The default is a compact circular directory avatar; `size="card"` uses a
 * 48px rounded-square portrait for compact three-line destination cards.
 * Callers supply the account name beside it and may hide the whole visual from
 * assistive technology when the provider is already named in the same control.
 */
export function ChannelAvatar({
  provider,
  channelName,
  picture,
  size = "default",
}: {
  provider: string;
  channelName: string;
  picture?: string | null;
  size?: "default" | "card";
}) {
  return (
    <span className={cn("relative flex shrink-0", size === "card" ? "size-12" : "size-9")}>
      <Avatar
        className={cn(
          "size-full border border-line bg-page",
          size === "card" ? "rounded-(--radius-control)" : "rounded-full",
        )}
      >
        <AvatarImage src={picture ?? undefined} alt="" />
        <AvatarFallback
          className={cn(
            "bg-inset font-medium text-ink-2",
            size === "card" ? "rounded-(--radius-control) text-base" : "rounded-full text-xs",
          )}
        >
          {getInitials(channelName)}
        </AvatarFallback>
      </Avatar>
      <span
        role="img"
        aria-label={platformDisplayName(provider)}
        className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-surface ring-2 ring-surface"
      >
        <PlatformIcon provider={provider} className="size-2.5" />
      </span>
    </span>
  );
}
