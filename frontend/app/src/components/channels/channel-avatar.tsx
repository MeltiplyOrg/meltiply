import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";

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
 * Callers supply the account name beside it and may hide the whole visual from
 * assistive technology when the provider is already named in the same control.
 */
export function ChannelAvatar({
  provider,
  channelName,
  picture,
}: {
  provider: string;
  channelName: string;
  picture?: string | null;
}) {
  return (
    <span className="relative flex size-9 shrink-0">
      <Avatar className="size-9 rounded-full border border-line bg-page">
        <AvatarImage src={picture ?? undefined} alt="" />
        <AvatarFallback className="rounded-full bg-inset text-xs font-medium text-ink-2">
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
