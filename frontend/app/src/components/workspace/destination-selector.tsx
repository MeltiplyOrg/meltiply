import { useCallback } from "react";
import { useWorkspace, type ChannelStatusInfo } from "@/context/workspace.context";
import type { ChannelIntegration } from "@/api/types";
import type { WorkspaceView } from "@/components/layout/navigation-shell";
import {
  BrandProfileSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import { TopToolbarButton } from "@/components/primitives/top-toolbar-button";

import { Button } from "@meltiply/ui/button";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { Check, Share2, Plus } from "lucide-react";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { platformDisplayName } from "@/lib/platforms";
import { cn } from "@meltiply/ui/utils";
import { Trans, useI18n } from "@/lib/i18n";

/**
 * Optional callback configuration for the DestinationSelector toolbar.
 */
export interface DestinationSelectorProps {
  /**
   * Optional navigation handler to transition between workspace views.
   * Accepts optional query options (e.g. `{ search: '?tab=add' }`) to deep link into sub-tabs.
   */
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
  /**
   * Optional direct callback to trigger the channel connection flow or open a connection modal.
   */
  onAddChannel?: () => void;
}

/**
 * Destination channel selector toolbar for choosing target social media accounts.
 *
 * Owns the composer's own Brand Profile picker: publishing targets exactly one
 * profile, so the block leads with the canonical `BrandProfileSelect` (without
 * the aggregate row, which cannot publish) and the profile choice lands in the
 * shared workspace selection the rest of the drawer already reads. Each
 * destination is one row led by the platform's logo, since these accounts
 * publish without avatars and the provider is what a creator recognizes.
 *
 * Filters connected integrations to the channels owned by the currently selected
 * Brand Profile (the aggregate "All Brand Profiles" view lists every channel but
 * is read-only for publishing), displays real-time connection status badges
 * (disabled, expired token, incomplete setup) driven by `channelStatuses` from
 * the workspace context, handles multi-select toggling via workspace context,
 * and provides quick navigation buttons to seamlessly transition into adding or
 * connecting new social channels.
 *
 * @param props - Navigation and channel addition action handlers.
 * @returns The rendered destination toolbar with the profile picker, selection pills, and quick-add actions.
 */
export function DestinationSelector({ onNavigate, onAddChannel }: DestinationSelectorProps = {}) {
  const {
    brandProfiles,
    integrations,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    selectedChannelIds,
    channelStatuses,
    toggleChannelSelection,
  } = useWorkspace();
  const { t } = useI18n();

  /**
   * Dispatches quick navigation to the channels view with the add-channel platform directory tab active.
   *
   * Uses `onAddChannel` when supplied; otherwise triggers `onNavigate('channels', { search: '?tab=add' })`.
   * Without either handler the button is inert — the composer always receives `onNavigate`
   * from its page wrapper, so no synthetic history fallback is attempted.
   */
  const handleAddChannel = useCallback(() => {
    if (onAddChannel) {
      onAddChannel();
      return;
    }
    onNavigate?.("channels", { search: "?tab=add" });
  }, [onAddChannel, onNavigate]);

  // Channels to display: the aggregate view lists every channel; a selected
  // Brand Profile strictly filters to the channels it owns.
  const displayedChannels = integrations.filter((ch: ChannelIntegration) => {
    if (selectedBrandProfileId === null) return true;
    return ch.brandProfileId === selectedBrandProfileId;
  });

  /**
   * Publishing targets exactly one Brand Profile. In the aggregate view the
   * directory still lists every account, but none of them can be selected, so
   * the block shows why instead of accepting a selection nothing can publish.
   */
  const canPublish = selectedBrandProfileId !== null;
  // Both loops below read these two collections per channel, so index them once
  // rather than scanning either list inside the render map. First occurrence wins,
  // matching the `find` calls they replace.
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

  /**
   * Trigger text for the profile picker. The aggregate sentinels are reported as
   * a missing choice rather than "All Brand Profiles", because publishing always
   * needs one owning profile; a concrete id resolves through the shared filter
   * label so the drawer, the Channels directory, and the Posts toolbar name the
   * same profile identically.
   */
  const profileLabel = selectedBrandProfileId
    ? brandProfileFilterLabel(selectedBrandProfileId, brandProfiles, t)
    : t("Choose a Brand Profile");

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
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

        {/* The profile is the destination's own first choice: the list below can
            only offer selectable channels once one profile owns the post. */}
        <BrandProfileSelect
          value={selectedBrandProfileId ?? ""}
          onValueChange={(id) => setSelectedBrandProfileId(id === "" ? null : id)}
          brandProfiles={brandProfiles}
          label={t("Brand Profile")}
          includeAggregate={false}
          trigger={<TopToolbarButton label={profileLabel} className="w-full" />}
        />

        {displayedChannels.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 rounded-control border border-dashed border-line px-3 py-4 text-center">
            <p className="text-(length:--font-size-ui) text-ink-3">
              {t("No social channels connected for this profile.")}
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
            {displayedChannels.map((channel: ChannelIntegration) => {
              const statusInfo = statusByChannelId.get(channel.id);
              const isAvailable = statusInfo?.isAvailable ?? true;
              const isSelected = selectedChannelIdSet.has(channel.id);
              const isUngrouped = channel.brandProfileId == null;

              // Unavailable accounts and the aggregate view share one
              // treatment: the row states the account's identity, and the
              // tooltip states the one reason it cannot be chosen.
              if (!isAvailable || !canPublish) {
                return (
                  <Tooltip key={channel.id}>
                    <TooltipTrigger asChild>
                      <div className="flex cursor-not-allowed select-none items-center gap-2 rounded-control border border-line bg-inset px-2 py-1.5 text-(length:--font-size-control) text-ink-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                          <PlatformIcon
                            provider={channel.providerIdentifier}
                            className="size-3.5"
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">{channel.name}</span>
                        {(channel.disabled || channel.refreshNeeded || channel.inBetweenSteps) && (
                          <span className="flex shrink-0 items-center gap-1 text-(length:--font-size-micro) text-red">
                            {channel.disabled
                              ? t("Disabled")
                              : channel.refreshNeeded
                                ? t("Expired")
                                : t("Incomplete")}
                          </span>
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {isAvailable
                          ? t("Choose a Brand Profile to pick publish destinations.")
                          : (statusInfo?.reason ?? t("Channel is unavailable"))}
                      </p>
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
                    "h-auto w-full justify-start gap-2 rounded-control border px-2 py-1.5 text-(length:--font-size-control) font-normal",
                    // Selected rows pin their own hover colors so the ghost
                    // variant's default hover cannot repaint the active state.
                    isSelected
                      ? "border-accent bg-accent-tint text-accent-ink hover:bg-accent-tint hover:text-accent-ink"
                      : "border-line bg-surface text-ink-2 hover:bg-hover hover:text-ink",
                  )}
                >
                  {/* The platform logo stands in for both the avatar these
                      accounts publish without and the slug a creator had to
                      read before. */}
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
                    <PlatformIcon provider={channel.providerIdentifier} className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{channel.name}</span>
                  {isUngrouped && (
                    <span className="shrink-0 text-(length:--font-size-micro) text-ink-3">
                      {t("(ungrouped)")}
                    </span>
                  )}
                  <span
                    className={cn(
                      "shrink-0 text-(length:--font-size-micro)",
                      isSelected ? "text-accent-ink/70" : "text-ink-3",
                    )}
                  >
                    {platformDisplayName(channel.providerIdentifier)}
                  </span>
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
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
