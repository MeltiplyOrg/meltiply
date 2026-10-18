import { useCallback } from "react";
import { useWorkspace, type ChannelStatusInfo } from "@/context/workspace.context";
import type { ChannelIntegration } from "@/api/types";
import type { WorkspaceView } from "@/components/layout/navigation-shell";

import { Button } from "@meltiply/ui/button";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { Check, AlertCircle, Share2, Layers, Plus } from "lucide-react";
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
 * Filters connected integrations to the channels owned by the currently selected
 * Brand Profile (the aggregate "All Brand Profiles" view lists every channel but
 * is read-only for publishing), displays real-time connection status badges
 * (disabled, expired token, incomplete setup) driven by `channelStatuses` from
 * the workspace context, handles multi-select toggling via workspace context,
 * and provides quick navigation buttons to seamlessly transition into adding or
 * connecting new social channels.
 *
 * @param props - Navigation and channel addition action handlers.
 * @returns The rendered destination toolbar with selection pills and quick-add actions.
 */
export function DestinationSelector({ onNavigate, onAddChannel }: DestinationSelectorProps = {}) {
  const {
    integrations,
    selectedBrandProfileId,
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
          <div className="flex items-center gap-2">
            {canPublish && (
              <span className="hidden items-center gap-1 text-(length:--font-size-micro) text-ink-3 sm:flex">
                <Layers className="size-3" aria-hidden="true" /> {t("Filtered by active profile")}
              </span>
            )}
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
        </div>

        {!canPublish && (
          <p className="text-(length:--font-size-micro) text-ink-3">
            {t("Choose a Brand Profile to pick publish destinations.")}
          </p>
        )}

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
          <div className="flex flex-wrap gap-1.5">
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
                      <div className="flex h-7 cursor-not-allowed items-center gap-1.5 rounded-control border border-line bg-inset px-2 text-(length:--font-size-control) text-ink-3 select-none">
                        <AlertCircle className="size-3.5" aria-hidden="true" />
                        <span className="font-medium">{channel.name}</span>
                        <span className="font-mono text-(length:--font-size-micro) uppercase">
                          {channel.providerIdentifier}
                        </span>
                        {channel.disabled && (
                          <span className="text-(length:--font-size-micro) text-red">
                            {t("Disabled")}
                          </span>
                        )}
                        {channel.refreshNeeded && (
                          <span className="text-(length:--font-size-micro) text-red">
                            {t("Expired")}
                          </span>
                        )}
                        {channel.inBetweenSteps && (
                          <span className="text-(length:--font-size-micro)">{t("Incomplete")}</span>
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
                    "h-7 max-w-full gap-1.5 rounded-control border px-2 text-(length:--font-size-control) font-normal",
                    // Selected chips pin their own hover colors so the ghost
                    // variant's default hover cannot repaint the active state.
                    isSelected
                      ? "border-accent bg-accent-tint text-accent-ink hover:bg-accent-tint hover:text-accent-ink"
                      : "border-line bg-surface text-ink-2 hover:bg-hover hover:text-ink",
                  )}
                >
                  {isSelected && <Check className="size-3 shrink-0" aria-hidden="true" />}
                  <span className="truncate">{channel.name}</span>
                  <span
                    className={cn(
                      "font-mono text-(length:--font-size-micro) uppercase",
                      isSelected ? "text-accent-ink/70" : "text-ink-3",
                    )}
                  >
                    {channel.providerIdentifier}
                  </span>
                  {isUngrouped && (
                    <span className="text-(length:--font-size-micro) text-ink-3">
                      {t("(ungrouped)")}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
