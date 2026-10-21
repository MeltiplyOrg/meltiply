import { useCallback, useState } from "react";
import { AlertCircle, ArrowLeft, Check, Link2, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { Alert } from "@meltiply/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { platformDisplayName } from "@/lib/platforms";
import {
  useCancelOAuthSelection,
  useConfirmOAuthSelection,
  useOAuthSelection,
} from "@/lib/queries";
import { brandProfileColorClass, type OAuthSelectionAccount } from "@/types";
import { cn } from "@meltiply/ui/utils";

export interface ChannelAssignmentProps {
  /** Opaque server assignment ticket nonce from callback parameters. */
  selectionId: string;
  /** Returns to the workspace without connecting a Channel. */
  onClose: () => void;
  /** Fired after the Channel is persisted under the chosen Brand Profile. */
  onSuccess: (accountName: string | null) => void;
}

/**
 * Resolves the authorized accounts and offers the Brand Profile choice.
 *
 * Account and Profile choices use native radios. Only connectable Profiles
 * appear in the bounded scrolling list, preserving workspace order. Reconnecting
 * the same account remains eligible. Confirmation supplies both ids; dismissal
 * discards the ticket.
 */
function ChannelAssignmentContent({ selectionId, onClose, onSuccess }: ChannelAssignmentProps) {
  const { t } = useI18n();
  const scope = useSessionScope();
  const { brandProfiles, integrations, isLoading: workspaceLoading } = useWorkspace();

  const selectionQuery = useOAuthSelection(scope, selectionId, true);
  const confirmMutation = useConfirmOAuthSelection(scope);
  const cancelMutation = useCancelOAuthSelection(scope);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isSubmitting = confirmMutation.isPending || cancelMutation.isPending;
  const selection = selectionQuery.data;
  const platform = selection?.platform;
  const platformName = platform ? platformDisplayName(platform) : null;
  const selectionUnavailable =
    selectionQuery.error instanceof ApiError && selectionQuery.error.status === 404;

  const effectiveAccountId =
    selectedAccountId ??
    (selection?.accounts.length === 1 ? (selection.accounts[0]?.id ?? null) : null);

  const channelByProfile: Record<string, (typeof integrations)[number]> = {};
  if (platform) {
    for (const integration of integrations) {
      if (integration.providerIdentifier.toLowerCase() === platform.toLowerCase()) {
        channelByProfile[integration.brandProfileId] = integration;
      }
    }
  }
  const isProfileAvailable = (profileId: string) => {
    const existingChannel = channelByProfile[profileId];
    return (
      !existingChannel ||
      (effectiveAccountId !== null && existingChannel.platformUserId === effectiveAccountId)
    );
  };
  const eligibleProfiles = brandProfiles.filter((profile) => isProfileAvailable(profile.id));
  const selectedProfile =
    selectedProfileId && eligibleProfiles.some((profile) => profile.id === selectedProfileId)
      ? selectedProfileId
      : null;

  /** Persists the chosen account under the chosen Profile; API conflicts stay visible for retry. */
  const handleConfirm = useCallback(() => {
    if (!effectiveAccountId || !selectedProfile || workspaceLoading || isSubmitting) return;
    setActionError(null);
    confirmMutation.mutate(
      {
        selectionId,
        input: { account_id: effectiveAccountId, brand_profile_id: selectedProfile },
      },
      {
        onSuccess: () => {
          const accountName =
            selection?.accounts.find((account) => account.id === effectiveAccountId)
              ?.display_name ?? null;
          onSuccess(accountName);
        },
        onError: (err) => {
          setActionError(
            err instanceof Error ? err.message : t("The selected Channel could not be connected."),
          );
        },
      },
    );
  }, [
    effectiveAccountId,
    selectedProfile,
    workspaceLoading,
    isSubmitting,
    confirmMutation,
    selectionId,
    selection,
    onSuccess,
    t,
  ]);

  /** Cancels a usable ticket before dismissal; missing/expired tickets close locally. */
  const handleCancel = useCallback(() => {
    if (isSubmitting) return;
    if (selectionUnavailable) {
      onClose();
      return;
    }
    setActionError(null);
    cancelMutation.mutate(selectionId, {
      onSuccess: onClose,
      onError: (error) => {
        if (error instanceof ApiError && error.status === 404) {
          onClose();
          return;
        }
        setActionError(
          error instanceof Error
            ? error.message
            : t("We could not complete that request. Try again in a moment."),
        );
      },
    });
  }, [isSubmitting, selectionUnavailable, cancelMutation, selectionId, onClose, t]);

  return (
    <section
      aria-labelledby="channel-assignment-title"
      className="grid w-full min-w-0 max-w-4xl overflow-hidden rounded-window border border-line bg-surface lg:grid-cols-[0.8fr_1fr]"
    >
      <aside className="flex flex-col justify-between gap-6 border-b border-line bg-canvas p-6 lg:gap-10 lg:border-r lg:border-b-0 lg:p-8">
        <div>
          <Link
            to="/channels"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 transition-colors hover:text-ink"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("Channels")}
          </Link>
        </div>

        <div className="max-w-sm space-y-4">
          <div className="mb-8 flex w-full items-center justify-center gap-5 py-2 sm:gap-6">
            <span
              role="img"
              aria-label="Meltiply"
              className="flex size-20 shrink-0 items-center justify-center text-ink sm:size-24"
            >
              <BrandMark className="size-12 sm:size-14" />
            </span>
            <Link2 className="size-6 shrink-0 text-ink-3" aria-hidden="true" />
            {platform ? (
              <span
                role="img"
                aria-label={platformName ?? platform}
                className="flex size-20 shrink-0 items-center justify-center sm:size-24"
              >
                <PlatformIcon provider={platform} className="size-12 sm:size-14" />
              </span>
            ) : (
              <Skeleton className="size-20 rounded-window sm:size-24" />
            )}
          </div>
          <h1
            id="channel-assignment-title"
            className="text-2xl font-semibold leading-8 tracking-tight text-ink text-balance"
          >
            {platformName
              ? t("Connect {platform}", { platform: platformName })
              : t("Connect a Channel")}
          </h1>
          <p className="text-sm leading-6 text-ink-2 text-pretty">
            {t("Choose the Channel and the Brand Profile that should own it.")}
          </p>
        </div>

        <div className="rounded-control border border-line bg-surface p-3 text-xs leading-relaxed text-ink-2 shadow-hairline">
          {t(
            "Each Brand Profile can hold one {platform} Channel. A Profile that already owns a different one is unavailable.",
            { platform: platformName ?? t("Channel") },
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-col p-6 sm:p-8">
        <div className="flex-1 space-y-6">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h2 className="text-base font-semibold text-ink">
                  {selection && selection.accounts.length > 1
                    ? t("Choose an account")
                    : t("Authorized account")}
                </h2>
                <p className="text-xs text-ink-2">
                  {selection && selection.accounts.length > 1
                    ? t("Select the account to connect.")
                    : platformName
                      ? t("The account authorized with {platform}.", {
                          platform: platformName,
                        })
                      : t("The provider authorized this account.")}
                </p>
              </div>
              {selection && selection.accounts.length > 1 ? (
                <span className="shrink-0 rounded-full border border-line bg-page px-2.5 py-1 text-xs font-semibold text-ink-2">
                  {t("{count} accounts", { count: selection.accounts.length })}
                </span>
              ) : null}
            </div>

            {selectionQuery.isLoading ? (
              <div className="space-y-2" role="status" aria-live="polite" aria-busy="true">
                <span className="sr-only">{t("Loading authorized accounts…")}</span>
                <div className="flex items-center gap-3 rounded-control border border-line p-3">
                  <Skeleton className="size-10 rounded-full shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              </div>
            ) : selectionQuery.isError ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-semibold">{t("Unable to load authorized accounts")}</p>
                  <p className="text-xs">
                    {selectionQuery.error instanceof Error
                      ? selectionQuery.error.message
                      : t("The assignment ticket has expired or could not be found.")}
                  </p>
                </div>
              </Alert>
            ) : !selection || selection.accounts.length === 0 ? (
              <div className="rounded-control border border-line bg-page p-4 text-center">
                <p className="text-sm font-semibold text-ink">{t("No eligible accounts found")}</p>
                <p className="mt-1 text-xs text-ink-2">
                  {t(
                    "The provider authorized without a publishable account. Check its permissions and try connecting again.",
                  )}
                </p>
              </div>
            ) : (
              <fieldset
                disabled={isSubmitting}
                data-lenis-prevent
                className="max-h-[32vh] min-w-0 space-y-2 overflow-y-auto overscroll-contain pr-1"
              >
                <legend className="sr-only">{t("Choose an account")}</legend>
                {selection.accounts.map((account: OAuthSelectionAccount) => {
                  const isSelected = effectiveAccountId === account.id;
                  return (
                    <label
                      key={account.id}
                      className={cn(
                        "group flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line p-3 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                        isSelected ? "bg-surface" : "bg-page hover:bg-hover",
                      )}
                    >
                      <Input
                        type="radio"
                        name={`channel-account-${selectionId}`}
                        value={account.id}
                        checked={isSelected}
                        onChange={() => setSelectedAccountId(account.id)}
                        className="sr-only"
                      />
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar className="size-10 shrink-0 border border-line">
                          <AvatarImage src={account.avatar_url ?? undefined} alt="" />
                          <AvatarFallback>
                            {(account.display_name?.slice(0, 2) ?? "CH").toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink">
                            {account.display_name ?? t("Unnamed account")}
                          </p>
                          <p className="break-words text-xs text-ink-3">
                            {account.username
                              ? `${account.username.startsWith("@") ? account.username : `@${account.username}`} · ${t("ID: {id}", { id: account.id })}`
                              : t("ID: {id}", { id: account.id })}
                          </p>
                        </div>
                      </div>

                      <div
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                          isSelected
                            ? "border-ink bg-ink text-surface"
                            : "border-line bg-page group-hover:border-ink-2",
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <Check className="size-3" />}
                      </div>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>

          <div className="space-y-3 border-t border-line pt-5">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-ink">{t("Brand Profile")}</h2>
              <p className="text-xs text-ink-2">
                {t("This Channel will publish and schedule for the selected profile.")}
              </p>
            </div>

            {!workspaceLoading && brandProfiles.length > 0 && eligibleProfiles.length === 0 ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <p className="text-xs">
                  {t(
                    "Every Brand Profile already has a {platform} Channel. Disconnect one or create another Brand Profile.",
                    { platform: platformName ?? t("Channel") },
                  )}
                </p>
              </Alert>
            ) : null}
            {workspaceLoading ? (
              <div className="space-y-2" role="status" aria-live="polite" aria-busy="true">
                <span className="sr-only">{t("Loading Brand Profiles…")}</span>
                <Skeleton className="h-14 rounded-control" />
                <Skeleton className="h-14 rounded-control" />
              </div>
            ) : brandProfiles.length === 0 ? (
              <Alert variant="destructive">
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <p className="text-xs">
                  {t("Create a Brand Profile before assigning this Channel.")}
                </p>
              </Alert>
            ) : eligibleProfiles.length === 0 ? null : (
              <fieldset
                disabled={isSubmitting}
                data-lenis-prevent
                className="-m-1 max-h-64 min-w-0 space-y-1 overflow-y-auto overscroll-contain p-1 [scrollbar-gutter:stable]"
              >
                <legend className="sr-only">{t("Brand Profile")}</legend>
                {eligibleProfiles.map((profile) => {
                  const existingChannel = channelByProfile[profile.id];
                  const canReconnect =
                    existingChannel !== undefined &&
                    effectiveAccountId !== null &&
                    existingChannel.platformUserId === effectiveAccountId;
                  const isSelected = selectedProfile === profile.id;
                  return (
                    <label
                      key={profile.id}
                      className={cn(
                        "group flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-control p-3 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                        isSelected ? "bg-hover" : "hover:bg-hover",
                      )}
                    >
                      <Input
                        type="radio"
                        name={`channel-profile-${selectionId}`}
                        value={profile.id}
                        checked={isSelected}
                        disabled={isSubmitting}
                        onChange={() => setSelectedProfileId(profile.id)}
                        className="sr-only"
                      />
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className={cn(
                            "size-2.5 shrink-0 rounded-full border border-line shadow-hairline",
                            brandProfileColorClass(profile.color),
                          )}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">{profile.name}</p>
                          {canReconnect ? (
                            <p className="text-xs text-ink-3">{t("Reconnect this Channel")}</p>
                          ) : null}
                        </div>
                      </div>

                      <div
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                          isSelected
                            ? "border-ink bg-ink text-surface"
                            : "border-line bg-page group-hover:border-ink-2",
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <Check className="size-3" />}
                      </div>
                    </label>
                  );
                })}
              </fieldset>
            )}
          </div>

          {actionError ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <p className="text-xs">{actionError}</p>
            </Alert>
          ) : null}
        </div>

        <footer className="mt-6 flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="outline"
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            {selectionUnavailable ? t("Close") : t("Cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            onClick={handleConfirm}
            disabled={
              !effectiveAccountId ||
              !selectedProfile ||
              isSubmitting ||
              workspaceLoading ||
              selectionQuery.isLoading ||
              selectionQuery.isError ||
              !selection ||
              selection.accounts.length === 0
            }
            className="w-full rounded-control font-medium sm:w-auto"
          >
            {confirmMutation.isPending ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {t("Connecting…")}
              </span>
            ) : (
              t("Connect Channel")
            )}
          </Button>
        </footer>
      </div>
    </section>
  );
}

/**
 * Full-page Channel assignment surface rendered after the OAuth callback.
 *
 * The callback hands over a sealed, owner-bound ticket; this view chooses the
 * authorized account (when more than one exists) and the owning Brand Profile
 * before any Channel is persisted. Success returns to Channels with the
 * connected outcome; cancel discards the ticket.
 *
 * @param props.selectionId - Sealed assignment ticket.
 * @param props.onClose - Returns without a connected Channel.
 * @param props.onSuccess - Reports the connected account before returning.
 * @returns Full-page assignment surface.
 */
export function ChannelAssignment({
  selectionId,
  onClose,
  onSuccess,
}: ChannelAssignmentProps): React.ReactElement {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-8 sm:py-12">
      <ChannelAssignmentContent selectionId={selectionId} onClose={onClose} onSuccess={onSuccess} />
    </main>
  );
}
