import { useCallback } from "react";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { useWorkspace, type ChannelStatusInfo } from "@/context/workspace.context";
import type { ChannelIntegration } from "@/api/types";
import type { WorkspaceView } from "@/lib/navigation";
import {
  BrandProfileFilterSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import { TopToolbarButton } from "@/components/primitives/top-toolbar-button";

import { Button } from "@meltiply/ui/button";
import { ChannelAvatar } from "@/components/channels/channel-avatar";
import { formatUsername } from "@/lib/format";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { Check, Share2, Plus } from "lucide-react";
import { platformDisplayName } from "@/lib/platforms";
import { cn } from "@meltiply/ui/utils";
import { Trans, useI18n } from "@/lib/i18n";

export interface DestinationSelectorProps {
  selectedProfileIds: string[];
  onProfilesChange: (ids: string[]) => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
  onAddChannel?: () => void;
}

function ChannelIdentityLines({
  channel,
  profileName,
  usernameLabel,
  mutedClass,
  idLabel,
}: {
  channel: ChannelIntegration;
  profileName: string;
  usernameLabel: string;
  mutedClass?: string;
  idLabel: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
      <span className="flex w-full min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-left font-medium">{channel.name}</span>
        <span className={cn("shrink-0 text-(length:--font-size-micro)", mutedClass)}>
          {platformDisplayName(channel.providerIdentifier)}
        </span>
      </span>
      <span
        className={cn(
          "w-full whitespace-normal break-all text-left text-(length:--font-size-micro)",
          mutedClass,
        )}
      >
        {usernameLabel}
      </span>
      <span className="text-left text-(length:--font-size-micro)">{profileName}</span>
      <span
        className={cn(
          "w-full whitespace-normal break-all text-left font-mono text-(length:--font-size-micro)",
          mutedClass,
        )}
      >
        {idLabel}
      </span>
    </span>
  );
}

export function DestinationSelector({
  selectedProfileIds,
  onProfilesChange,
  onNavigate,
  onAddChannel,
}: DestinationSelectorProps) {
  const {
    brandProfiles,
    integrations,

    selectedChannelIds,
    channelStatuses,
    toggleChannelSelection,
  } = useWorkspace();
  const { t } = useI18n();

  const handleAddChannel = useCallback(() => {
    if (onAddChannel) {
      onAddChannel();
      return;
    }
    onNavigate?.("channels", { search: "?tab=add" });
  }, [onAddChannel, onNavigate]);

  const profileIds = new Set(selectedProfileIds);
  const displayedChannels = integrations.filter(
    (channel) => channel.brandProfileId !== null && profileIds.has(channel.brandProfileId),
  );
  const groupedChannels = new Map<string, ChannelIntegration[]>();
  for (const channel of displayedChannels) {
    const provider = channel.providerIdentifier.toLowerCase();
    const group = groupedChannels.get(provider);
    if (group) group.push(channel);
    else groupedChannels.set(provider, [channel]);
  }
  const profileNames = new Map(brandProfiles.map((profile) => [profile.id, profile.name]));
  const selectedChannelIdSet = new Set(selectedChannelIds);
  const statusByChannelId = new Map<string, ChannelStatusInfo>();
  for (const status of channelStatuses) {
    if (!statusByChannelId.has(status.integration.id)) {
      statusByChannelId.set(status.integration.id, status);
    }
  }
  const selectedCount = displayedChannels.filter((ch: ChannelIntegration) =>
    selectedChannelIdSet.has(ch.id),
  ).length;

  const profileLabel =
    selectedProfileIds.length > 1
      ? t("{count} Brand Profiles", { count: selectedProfileIds.length })
      : selectedProfileIds.length === 1
        ? brandProfileFilterLabel(selectedProfileIds[0], brandProfiles, t)
        : t("Choose Brand Profiles");

  return (
    <TooltipProvider>
      <section aria-label={t("Destinations")} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Share2 className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            <h3 className="text-(length:--font-size-ui) font-semibold text-ink">
              {t("Destinations")}
            </h3>
            <span className="rounded-chip bg-hover-2 px-1.5 text-(length:--font-size-micro) text-ink-3">
              <Trans
                message="{count} selected"
                values={{ count: <RollingCount value={selectedCount} /> }}
              />
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAddChannel}
            className="h-7 gap-1.5 px-2 text-(length:--font-size-control)"
          >
            <Plus className="size-3.5" />
            <span>{t("Add Channel")}</span>
          </Button>
        </div>

        <BrandProfileFilterSelect
          value={selectedProfileIds}
          onValueChange={onProfilesChange}
          brandProfiles={brandProfiles}
          unresolvedProfileIds={selectedProfileIds}
          includeAggregate={false}
          trigger={<TopToolbarButton label={profileLabel} className="w-full" />}
        />
        <p className="text-(length:--font-size-micro) leading-relaxed text-ink-3">
          {t(
            "Creates one independent Post per selected Brand Profile. Media is copied into each profile.",
          )}
        </p>

        {displayedChannels.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 rounded-control border border-dashed border-line px-3 py-4 text-center">
            <p className="text-(length:--font-size-ui) text-ink-3">
              {selectedProfileIds.length === 0
                ? t("Choose Brand Profiles to see their channels.")
                : t("No social channels connected for the selected profiles.")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddChannel}
              className="h-7 gap-1.5 px-2 text-(length:--font-size-control)"
            >
              <Plus className="size-3.5" />
              <span>{t("Connect a channel")}</span>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {[...groupedChannels].map(([provider, channels]) => (
              <section
                key={provider}
                aria-label={platformDisplayName(provider)}
                className="flex flex-col gap-1.5"
              >
                <h4 className="flex items-center gap-2 pt-2 text-xs font-medium text-ink-3">
                  <PlatformIcon provider={provider} className="size-3.5" />
                  {platformDisplayName(provider)}
                </h4>
                {channels.map((channel: ChannelIntegration) => {
                  const statusInfo = statusByChannelId.get(channel.id);
                  const isAvailable = statusInfo?.isAvailable ?? true;
                  const isSelected = selectedChannelIdSet.has(channel.id);
                  const username = formatUsername(channel.username);
                  const usernameLabel = username
                    ? t("Username: {username}", { username })
                    : t("Username not provided");
                  const avatar = (
                    <span aria-hidden="true" className="shrink-0">
                      <ChannelAvatar
                        provider={channel.providerIdentifier}
                        channelName={channel.name}
                        picture={channel.picture}
                        size="card"
                      />
                    </span>
                  );

                  const profileName =
                    profileNames.get(channel.brandProfileId ?? "") ?? t("Unknown profile");
                  const idLabel = t("ID: {id}", { id: channel.platformUserId });

                  if (!isAvailable) {
                    return (
                      <Tooltip key={channel.id}>
                        <TooltipTrigger asChild>
                          <div className="flex cursor-not-allowed select-none items-center gap-2 rounded-control border border-line bg-inset p-2 text-(length:--font-size-control) text-ink-3">
                            {avatar}
                            <ChannelIdentityLines
                              channel={channel}
                              profileName={profileName}
                              usernameLabel={usernameLabel}
                              idLabel={idLabel}
                            />
                            {(channel.disabled || channel.refreshNeeded) && (
                              <span className="flex shrink-0 items-center gap-1 text-(length:--font-size-micro) text-red">
                                {channel.disabled ? t("Disabled") : t("Expired")}
                              </span>
                            )}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{statusInfo?.reason ?? t("Channel is unavailable")}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  }

                  return (
                    <Button
                      key={channel.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-pressed={isSelected}
                      onClick={() => toggleChannelSelection(channel.id)}
                      className={cn(
                        "h-auto w-full justify-start gap-2 rounded-control border p-2 text-(length:--font-size-control) font-normal",
                        isSelected
                          ? "border-accent bg-accent-tint text-accent-ink hover:bg-accent-tint hover:text-accent-ink"
                          : "border-line bg-surface text-ink-2 hover:bg-hover hover:text-ink",
                      )}
                    >
                      {avatar}
                      <ChannelIdentityLines
                        channel={channel}
                        profileName={profileName}
                        usernameLabel={usernameLabel}
                        idLabel={idLabel}
                        mutedClass={isSelected ? "text-accent-ink/70" : "text-ink-3"}
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center",
                          isSelected ? "text-accent-ink" : "text-ink-3",
                        )}
                      >
                        {isSelected && <Check className="size-3.5" />}
                      </span>
                    </Button>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </section>
    </TooltipProvider>
  );
}
