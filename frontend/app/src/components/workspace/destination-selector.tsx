import { useCallback } from "react";
import { useWorkspace, type ChannelStatusInfo } from "@/context/workspace.context";
import type { ChannelIntegration } from "@/api/types";
import type { WorkspaceView } from "@/components/layout/navigation-shell";
import { Badge } from "@meltiply/ui/badge";
import { Button } from "@meltiply/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { Check, AlertCircle, Share2, Layers, Plus } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";

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

  const selectedCount = selectedChannelIds.length;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Share2 className="size-4 text-foreground" />
            <h4 className="text-sm font-semibold tracking-tight text-foreground">
              {t("Destinations")}
            </h4>
            <Badge variant="outline" className="font-mono text-xs">
              {t("{count} selected", { count: selectedCount })}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            {selectedBrandProfileId !== null && (
              <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                <Layers className="size-3" /> {t("Filtered by active profile")}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddChannel}
              className="h-7 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Plus className="size-3.5" />
              <span>{t("Add Channel")}</span>
            </Button>
          </div>
        </div>

        {displayedChannels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            <p>{t("No social channels connected for this profile.")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddChannel}
              className="h-8 gap-1.5 px-3 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Plus className="size-3.5" />
              <span>{t("Connect a channel")}</span>
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {displayedChannels.map((channel: ChannelIntegration) => {
              const statusInfo = channelStatuses.find(
                (s: ChannelStatusInfo) => s.integration.id === channel.id,
              );
              const isAvailable = statusInfo?.isAvailable ?? true;
              const isSelected = selectedChannelIds.includes(channel.id);
              const isUngrouped = channel.brandProfileId == null;

              if (!isAvailable) {
                return (
                  <Tooltip key={channel.id}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground opacity-60 cursor-not-allowed select-none",
                        )}
                      >
                        <AlertCircle className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{channel.name}</span>
                        <Badge
                          variant="outline"
                          className="font-mono text-[9px] uppercase tracking-wider"
                        >
                          {channel.providerIdentifier}
                        </Badge>
                        {channel.disabled && (
                          <span className="text-[10px] text-destructive">{t("Disabled")}</span>
                        )}
                        {channel.refreshNeeded && (
                          <span className="text-[10px] text-destructive">{t("Expired")}</span>
                        )}
                        {channel.inBetweenSteps && (
                          <span className="text-[10px] text-muted-foreground">
                            {t("Incomplete")}
                          </span>
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{statusInfo?.reason || t("Channel is unavailable")}</p>
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
                  onClick={() => toggleChannelSelection(channel.id)}
                  className={cn(
                    "group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    // Selected pills pin hover colors so the ghost variant's
                    // default hover cannot repaint the active state.
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded border transition-colors",
                      isSelected
                        ? "border-primary-foreground bg-primary-foreground text-primary"
                        : "border-muted-foreground/40 bg-transparent",
                    )}
                  >
                    {isSelected && <Check className="size-3 stroke-[3]" />}
                  </span>
                  <span className="truncate max-w-[140px]">{channel.name}</span>
                  <Badge
                    variant={isSelected ? "outline" : "secondary"}
                    className={cn(
                      "font-mono text-[9px] uppercase tracking-wider",
                      isSelected && "border-primary-foreground/30 text-primary-foreground",
                    )}
                  >
                    {channel.providerIdentifier}
                  </Badge>
                  {isUngrouped && (
                    <span
                      className={cn(
                        "text-[10px]",
                        isSelected ? "text-primary-foreground/70" : "text-muted-foreground",
                      )}
                    >
                      {t("(ungrouped)")}
                    </span>
                  )}
                </Button>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAddChannel}
              className="group flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-foreground/40 hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={t("Add or connect a new social channel")}
            >
              <Plus className="size-3.5" />
              <span>{t("Add Channel")}</span>
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
