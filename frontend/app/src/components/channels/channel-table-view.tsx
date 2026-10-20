import React from "react";
import { TooltipProvider } from "@meltiply/ui/tooltip";
import { Input } from "@meltiply/ui/input";
import { useI18n } from "@/lib/i18n";
import { brandProfileColorClass, type BrandProfile, type PlatformAccount } from "@/types";
import { cn } from "@meltiply/ui/utils";
import {
  ChannelAvatar,
  ChannelCopyRows,
  ChannelHealthControl,
  ChannelSelectionCheckbox,
  ChannelSettingsAction,
  channelDisplayTitle,
} from "./channel-shared";

/**
 * Fully resolved presentation state for one connected channel row, derived by
 * the board so the table stays a pure projection of filtered data.
 */
export interface ChannelTableEntry {
  account: PlatformAccount;
  /** Owning Brand Profile, or null if it no longer resolves. */
  profile: BrandProfile | null;
  /** Workspace integration display name override, else provider display name. */
  displayName?: string | null;
  /** Workspace integration picture override, else provider avatar URL. */
  picture?: string | null;
  /** Workspace health annotation; `null` defers to the contract status. */
  statusReason: string | null;
  /** True while this channel's platform is mid OAuth redirect. */
  isReconnecting: boolean;
}

export interface ChannelTableViewProps {
  channels: ChannelTableEntry[];
  /** Ids in the current bulk selection; may include channels hidden by filters. */
  selectedIds: ReadonlySet<string>;
  /** Every visible row is selected. */
  allVisibleSelected: boolean;
  /** Some, but not all, visible rows are selected (header indeterminate state). */
  visibleSelectionIndeterminate: boolean;
  /** Toggles selection across exactly the currently visible rows. */
  onToggleVisibleSelection: () => void;
  /** Toggles one channel id in the bulk selection. */
  onToggleSelection: (id: string) => void;
  /** Disables every selection control while a bulk operation runs. */
  selectionDisabled?: boolean;
  lowMotion: boolean;
  /** Admin-only; omitted for read-only roles. */
  onReconnect?: (account: PlatformAccount) => void;
  /** Admin-only; omitted for read-only roles. */
  onDisconnect?: (account: PlatformAccount) => void;
}

/**
 * Renders the connected channel directory with copy, health, and settings controls.
 * The header checkbox selects exactly the visible rows; hidden selected channels
 * keep their bulk-selection membership untouched as filters change.
 */
export function ChannelTableView({
  channels,
  selectedIds,
  allVisibleSelected,
  visibleSelectionIndeterminate,
  onToggleVisibleSelection,
  onToggleSelection,
  selectionDisabled = false,
  lowMotion,
  onReconnect,
  onDisconnect,
}: ChannelTableViewProps): React.ReactElement {
  const { t, tStatus } = useI18n();
  return (
    <TooltipProvider delayDuration={250}>
      <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <table className="w-full min-w-[720px] text-left text-xs text-ink">
          <thead className="border-b border-line bg-page text-[11px] font-semibold uppercase tracking-wider text-ink-2 select-none">
            <tr>
              <th className="w-12 py-2.5 pl-4 pr-2">
                <Input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={selectionDisabled || channels.length === 0}
                  aria-label={t("Select all visible channels")}
                  ref={(el) => {
                    if (el) el.indeterminate = visibleSelectionIndeterminate;
                  }}
                  onChange={onToggleVisibleSelection}
                />
              </th>
              <th className="min-w-[240px] py-2.5 px-3">{t("Channel")}</th>
              <th className="min-w-[140px] py-2.5 px-3">{t("Brand Profile")}</th>
              <th className="min-w-[120px] py-2.5 px-3">{t("Status")}</th>
              <th className="py-2.5 pl-3 pr-4 text-right">{t("Actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {channels.map((entry) => {
              const { account, profile, picture, statusReason, isReconnecting } = entry;
              const selected = selectedIds.has(account.id);
              const channelName = channelDisplayTitle(account, entry.displayName);
              return (
                <tr
                  key={account.id}
                  data-testid={`channel-row-${account.id}`}
                  data-selected={selected || undefined}
                  className={cn("transition-colors hover:bg-hover/50", selected && "bg-hover/40")}
                >
                  <td className="py-2.5 pl-4 pr-2">
                    <ChannelSelectionCheckbox
                      checked={selected}
                      disabled={selectionDisabled}
                      label={t("Select channel")}
                      onToggle={() => onToggleSelection(account.id)}
                    />
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2.5">
                      <ChannelAvatar
                        account={account}
                        channelName={channelName}
                        picture={picture}
                      />
                      <div className="min-w-0">
                        <div
                          className="truncate text-[13px] font-semibold text-ink"
                          title={channelName}
                        >
                          {channelName}
                        </div>
                        <ChannelCopyRows account={account} />
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-full border border-line",
                          profile ? brandProfileColorClass(profile.color) : "bg-line",
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate font-medium text-ink-2">
                        {profile?.name ?? t("Unknown profile")}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-1.5">
                      <ChannelHealthControl
                        account={account}
                        statusReason={statusReason}
                        isReconnecting={isReconnecting}
                        lowMotion={lowMotion}
                        onReconnect={onReconnect}
                      />
                      <span className="truncate capitalize text-ink-2">
                        {tStatus(account.connection_status)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 pl-3 pr-4 text-right whitespace-nowrap">
                    <ChannelSettingsAction
                      account={account}
                      profile={profile}
                      channelName={channelName}
                      onDisconnect={onDisconnect}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
