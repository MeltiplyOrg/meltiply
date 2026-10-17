import React from "react";
import { TooltipProvider } from "@meltiply/ui/tooltip";
import { Input } from "@meltiply/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@meltiply/ui/table";
import { useI18n } from "@/lib/i18n";
import { platformDisplayName } from "@/lib/platforms";
import { PlatformIcon } from "@/components/primitives/platform-icon";
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

/** Resolved real account metadata; absent profiles remain visible as unknown ownership. */
export interface ChannelTableEntry {
  account: PlatformAccount;
  profile: BrandProfile | null;
  displayName?: string | null;
  picture?: string | null;
  statusReason: string | null;
  isReconnecting: boolean;
}

export interface ChannelTableViewProps {
  channels: ChannelTableEntry[];
  selectedIds: ReadonlySet<string>;
  allVisibleSelected: boolean;
  onToggleVisibleSelection: () => void;
  onToggleSelection: (id: string) => void;
  selectionDisabled?: boolean;
  lowMotion: boolean;
  onReconnect: (account: PlatformAccount) => void;
  onDisconnect: (account: PlatformAccount) => void;
}

/**
 * Gr8r Members' inset directory adapted to channel identity, platform, ownership,
 * health, and real settings. Shared Table owns density and dividers; selection
 * changes visible accounts without clearing hidden ids.
 */
export function ChannelTableView({
  channels,
  selectedIds,
  allVisibleSelected,
  onToggleVisibleSelection,
  onToggleSelection,
  selectionDisabled = false,
  lowMotion,
  onReconnect,
  onDisconnect,
}: ChannelTableViewProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <TooltipProvider>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <Table variant="directory" className="min-w-220" aria-label={t("Connected accounts")}>
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-30" />
            <col className="w-42.5" />
            <col className="w-42.5" />
            <col className="w-14" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={selectionDisabled || channels.length === 0}
                  aria-label={t("Select all visible channels")}
                  onChange={onToggleVisibleSelection}
                />
              </TableHead>
              <TableHead>{t("Channel")}</TableHead>
              <TableHead>{t("Platform")}</TableHead>
              <TableHead>{t("Brand Profile")}</TableHead>
              <TableHead>{t("Connection")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("Actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((entry) => {
              const { account, profile, picture, statusReason, isReconnecting } = entry;
              const selected = selectedIds.has(account.id);
              const channelName = channelDisplayTitle(account, entry.displayName);
              return (
                <TableRow
                  key={account.id}
                  data-testid={`channel-row-${account.id}`}
                  data-selected={selected || undefined}
                >
                  <TableCell>
                    <ChannelSelectionCheckbox
                      checked={selected}
                      disabled={selectionDisabled}
                      label={t("Select channel")}
                      onToggle={() => onToggleSelection(account.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ChannelAvatar
                        account={account}
                        channelName={channelName}
                        picture={picture}
                      />
                      <div className="min-w-0">
                        <div
                          className="truncate text-(length:--font-size-ui) font-medium text-ink"
                          title={channelName}
                        >
                          {channelName}
                        </div>
                        <ChannelCopyRows account={account} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <PlatformIcon provider={account.platform} className="size-3.5" />
                      {platformDisplayName(account.platform)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-chip",
                          profile ? brandProfileColorClass(profile.color) : "bg-line",
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate">{profile?.name ?? t("Unknown profile")}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <ChannelHealthControl
                      account={account}
                      statusReason={statusReason}
                      isReconnecting={isReconnecting}
                      lowMotion={lowMotion}
                      onReconnect={onReconnect}
                    />
                  </TableCell>
                  <TableCell>
                    <ChannelSettingsAction
                      account={account}
                      profile={profile}
                      channelName={channelName}
                      onDisconnect={onDisconnect}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}
