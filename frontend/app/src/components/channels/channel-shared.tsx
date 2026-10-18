import React, { useCallback, useState } from "react";
import { Check, Copy, Ellipsis, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { copyText } from "@meltiply/ui/copy-text";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogTrigger,
} from "@meltiply/ui/center-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@meltiply/ui/tooltip";
import { toast } from "@meltiply/ui/toast";
import { type BrandProfile, type PlatformAccount } from "@/types";
import { platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import { cn } from "@meltiply/ui/utils";

/**
 * Consistent icon-button chrome for the channel table's copy, health, and settings controls.
 */
const channelActionClass =
  "size-7 shrink-0 text-ink-3 hover:bg-hover hover:text-ink [&_svg]:size-3.5";

/** Displays only real, nonblank handles, adding @ without changing their copy value. */
function formatUsername(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

/**
 * Resolves the channel's display title for its table row and settings dialog:
 * an explicit override (the workspace integration name), the provider display
 * name, then the platform label as last resort so the identity never renders blank.
 */
export function channelDisplayTitle(account: PlatformAccount, displayName?: string | null): string {
  return (
    displayName?.trim() || account.display_name?.trim() || platformDisplayName(account.platform)
  );
}

/**
 * Returns a clipboard helper that copies a provider value and reports through
 * Sileo: a confirmed copy gets an action-specific title plus the copied value as
 * expandable detail, while denied clipboard access shows manual-copy recovery
 * instead of claiming success.
 */
function useCopyChannelValue(): (value: string, successTitle: string) => Promise<void> {
  const { t } = useI18n();
  return useCallback(
    async (value: string, successTitle: string): Promise<void> => {
      try {
        await copyText(value);
        toast(successTitle, {
          description: t("Copied “{value}” to your clipboard.", { value }),
          variant: "success",
        });
      } catch {
        toast(t("Could not copy"), {
          description: t("Select the value and copy it manually."),
          variant: "error",
        });
      }
    },
    [t],
  );
}

export interface ChannelCopyRowsProps {
  account: PlatformAccount;
}

/**
 * Renders copyable handle and provider ID rows; missing values are omitted so a
 * channel with no username never shows an empty row. Each row copies the raw
 * provider value (without the display @ prefix or ID label) via the shared
 * clipboard helper. Values truncate while copy buttons align at the row's right edge.
 */
export function ChannelCopyRows({ account }: ChannelCopyRowsProps): React.ReactElement | null {
  const { t } = useI18n();
  const copyValue = useCopyChannelValue();
  const formattedUsername = formatUsername(account.username);
  const providerId = account.platform_user_id?.trim();
  if (!formattedUsername && !providerId) return null;
  return (
    <div className="mt-0.5 space-y-0.5">
      {formattedUsername && (
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={formattedUsername}>
            {formattedUsername}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={channelActionClass}
            aria-label={t("Copy username")}
            onClick={() => void copyValue(account.username!.trim(), t("Username copied"))}
          >
            <Copy aria-hidden="true" />
          </Button>
        </div>
      )}
      {providerId && (
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-3" title={providerId}>
            {t("ID: {id}", { id: providerId })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={channelActionClass}
            aria-label={t("Copy channel ID")}
            onClick={() => void copyValue(providerId, t("Channel ID copied"))}
          >
            <Copy aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );
}

export interface ChannelHealthControlProps {
  account: PlatformAccount;
  statusReason?: string | null;
  isReconnecting?: boolean;
  onReconnect: (account: PlatformAccount) => void;
}

/**
 * Renders the table's channel-health icon with a tooltip and accessible name.
 * Healthy channels use a passive control; unhealthy ones open a dropdown with
 * the reason and real re-authentication action, delegated to the board's OAuth flow.
 */
export function ChannelHealthControl({
  account,
  statusReason = null,
  isReconnecting = false,
  onReconnect,
}: ChannelHealthControlProps): React.ReactElement {
  const { t, tStatus } = useI18n();
  const healthy = account.connection_status === "connected" && !statusReason;
  const healthDescription = statusReason || tStatus(account.connection_status);
  const statusControl = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        channelActionClass,
        healthy ? "text-green hover:text-green" : "text-orange hover:text-orange",
      )}
      aria-label={healthDescription}
    >
      {healthy ? <Check aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
    </Button>
  );
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {healthy ? (
            statusControl
          ) : (
            <DropdownMenuTrigger asChild>{statusControl}</DropdownMenuTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{healthDescription}</TooltipContent>
      </Tooltip>
      {!healthy && (
        <DropdownMenuContent align="end" className="max-w-72">
          <p className="px-2 py-1.5 text-xs text-ink-2">{healthDescription}</p>
          <DropdownMenuItem disabled={isReconnecting} onSelect={() => onReconnect(account)}>
            <RefreshCw
              className={cn("size-3.5", isReconnecting && "animate-spin")}
              aria-hidden="true"
            />
            {isReconnecting ? t("Redirecting…") : t("Re-authenticate")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

export interface ChannelSettingsActionProps {
  account: PlatformAccount;
  /** Resolved owning Brand Profile; missing profiles surface as "Unknown profile". */
  profile?: BrandProfile | null;
  /** Resolved display title used as the dialog's accessible name. */
  channelName: string;
  onDisconnect: (account: PlatformAccount) => void;
}

/**
 * Renders the directory's overflow trigger and real channel settings dialog.
 * The dialog shows the owning Brand Profile and the real granted scopes, and
 * its destructive action closes the dialog before delegating to the board's
 * disconnect confirmation so exactly one CenterAlertDialog is ever active.
 */
export function ChannelSettingsAction({
  account,
  profile = null,
  channelName,
  onDisconnect,
}: ChannelSettingsActionProps): React.ReactElement {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const platformName = platformDisplayName(account.platform);
  return (
    <CenterDialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <CenterDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Channel settings")}
              className={channelActionClass}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </CenterDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("Channel settings")}</TooltipContent>
      </Tooltip>
      <CenterDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" data-lenis-prevent>
        <CenterDialogHeader>
          <CenterDialogTitle>{channelName}</CenterDialogTitle>
          <CenterDialogDescription>
            {t("Channel settings")} · {platformName}
          </CenterDialogDescription>
        </CenterDialogHeader>
        <div className="space-y-5 py-2">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-ink-2">{t("Brand Profile")}</span>
            <span className="truncate font-medium text-ink">
              {profile?.name ?? t("Unknown profile")}
            </span>
          </div>
          <section
            className="space-y-3 border-t border-line-soft pt-4"
            aria-label={t("Permissions")}
          >
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium text-ink">{t("Permissions")}</h4>
              {account.capabilities?.publish && (
                <span className="text-xs text-green">{t("Publishing")}</span>
              )}
            </div>
            {account.scopes?.length ? (
              <ul className="space-y-2 text-xs text-ink-2">
                {account.scopes.map((scope) => (
                  <li key={scope} className="break-all font-mono">
                    {scope}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">{t("No permissions granted")}</p>
            )}
          </section>
          <div className="border-t border-line-soft pt-4">
            <Button
              type="button"
              variant="outline"
              className="text-red hover:bg-red-tint hover:text-red"
              onClick={() => {
                setSettingsOpen(false);
                onDisconnect(account);
              }}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t("Disconnect")}
            </Button>
          </div>
        </div>
      </CenterDialogContent>
    </CenterDialog>
  );
}

export interface ChannelSelectionCheckboxProps {
  checked: boolean;
  disabled?: boolean;
  /** Accessible name, e.g. "Select channel" or "Select all visible channels". */
  label: string;
  onToggle: () => void;
  className?: string;
}

/**
 * Single-channel selection checkbox built on the shared Input primitive. The
 * click stops at the input so selection never triggers card or row navigation
 * in interactive containers.
 */
export function ChannelSelectionCheckbox({
  checked,
  disabled = false,
  label,
  onToggle,
  className,
}: ChannelSelectionCheckboxProps): React.ReactElement {
  return (
    <Input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      className={className}
      onClick={(event) => event.stopPropagation()}
      onChange={onToggle}
    />
  );
}
