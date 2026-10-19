import React, { useCallback, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Alert } from "@meltiply/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { Button } from "@meltiply/ui/button";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogFooter,
  CenterDialogHeader,
  CenterDialogTitle,
} from "@meltiply/ui/center-dialog";
import { Input } from "@meltiply/ui/input";
import { Skeleton } from "@meltiply/ui/skeleton";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import {
  useCancelOAuthSelection,
  useConfirmOAuthSelection,
  useOAuthSelection,
} from "@/lib/queries";
import { brandProfileColorClass, type OAuthSelectionAccount } from "@/types";
import { cn } from "@meltiply/ui/utils";

export interface FacebookPageSelectionDialogProps {
  /** Controlled open state of the modal dialog. */
  open: boolean;
  /** Visibility change callback. */
  onOpenChange: (open: boolean) => void;
  /** Opaque server selection ticket nonce from callback parameters. */
  selectionId: string | null;
  /** Callback fired upon successful connection confirmation, carrying the chosen Page's display name so the caller can include it in feedback. */
  onSuccess: (pageName: string | null) => void;
}

interface FacebookPageSelectionDialogContentProps {
  open: boolean;
  selectionId: string;
  onClose: () => void;
  onSuccess: (pageName: string | null) => void;
}

/**
 * Lists authorized Pages without preselecting one, using native radios for keyboard access.
 * Confirmation saves only the chosen Page; dismissal discards the owner-bound ticket.
 * Recoverable API errors keep the selection open, and in-flight mutations prevent dismissal.
 */
function FacebookPageSelectionDialogContent({
  open,
  selectionId,
  onClose,
  onSuccess,
}: FacebookPageSelectionDialogContentProps) {
  const { t } = useI18n();
  const scope = useSessionScope();
  const { brandProfiles } = useWorkspace();

  const selectionQuery = useOAuthSelection(scope, selectionId, open);
  const confirmMutation = useConfirmOAuthSelection(scope);
  const cancelMutation = useCancelOAuthSelection(scope);

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isSubmitting = confirmMutation.isPending || cancelMutation.isPending;
  const selection = selectionQuery.data;
  const selectionUnavailable =
    selectionQuery.error instanceof ApiError && selectionQuery.error.status === 404;

  // Pin the target Brand Profile strictly from the server-persisted selection ticket,
  // preventing ambient/global dropdown switches from mutating the intended owner.
  const pinnedProfile = selection
    ? brandProfiles.find((p) => p.id === selection.brand_profile_id)
    : null;

  /** Saves the explicitly chosen Page, reporting its display name to the caller's success feedback; failures preserve the choice and visible API error. */
  const handleConfirm = useCallback(() => {
    if (!selectedAccountId || isSubmitting) return;
    setActionError(null);
    confirmMutation.mutate(
      {
        selectionId,
        input: { account_id: selectedAccountId },
      },
      {
        onSuccess: () => {
          const pageName =
            selection?.accounts.find((account) => account.id === selectedAccountId)?.display_name ??
            null;
          onSuccess(pageName);
          onClose();
        },
        onError: (err) => {
          const message =
            err instanceof Error ? err.message : t("The selected Page could not be connected.");
          setActionError(message);
        },
      },
    );
  }, [
    selectedAccountId,
    isSubmitting,
    confirmMutation,
    selectionId,
    selection,
    onSuccess,
    onClose,
    t,
  ]);

  /** Cancels a usable ticket before dismissal; missing/expired tickets need only a local close. */
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
    <CenterDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel();
      }}
    >
      <CenterDialogContent className="sm:max-w-[480px]">
        <CenterDialogHeader>
          <CenterDialogTitle>{t("Select Facebook Page")}</CenterDialogTitle>
          <CenterDialogDescription>
            {t("Choose the Facebook Page you want to connect to your Brand Profile.")}
          </CenterDialogDescription>
        </CenterDialogHeader>

        {pinnedProfile ? (
          <div className="flex items-center gap-2 rounded-control border border-line bg-page px-3 py-2 text-xs text-ink-2">
            <span className="font-medium text-ink">{t("Connecting to:")}</span>
            <span
              className={cn(
                "size-2.5 rounded-full shrink-0 border border-line shadow-hairline",
                brandProfileColorClass(pinnedProfile.color),
              )}
              aria-hidden="true"
            />
            <span className="font-semibold text-ink">{pinnedProfile.name}</span>
          </div>
        ) : null}

        <div className="py-2">
          {selectionQuery.isLoading ? (
            <div className="space-y-3 py-2" role="status" aria-live="polite" aria-busy="true">
              <span className="sr-only">{t("Loading eligible Facebook Pages…")}</span>
              <div className="flex items-center gap-3 rounded-control border border-line p-3">
                <Skeleton className="size-10 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-control border border-line p-3">
                <Skeleton className="size-10 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            </div>
          ) : selectionQuery.isError ? (
            <Alert variant="destructive" className="my-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-semibold">{t("Unable to load Facebook Pages")}</p>
                <p className="text-xs">
                  {selectionQuery.error instanceof Error
                    ? selectionQuery.error.message
                    : t("The selection ticket has expired or could not be found.")}
                </p>
              </div>
            </Alert>
          ) : !selection || selection.accounts.length === 0 ? (
            <div className="rounded-control border border-line bg-page p-4 text-center">
              <p className="text-sm font-semibold text-ink">
                {t("No eligible Facebook Pages found")}
              </p>
              <p className="mt-1 text-xs text-ink-2">
                {t(
                  "You need admin or publishing access on at least one Facebook Page to connect it. Create or request access to a Page in Facebook, then try connecting again.",
                )}
              </p>
            </div>
          ) : (
            <fieldset
              disabled={isSubmitting}
              className="max-h-[50vh] min-w-0 space-y-2 overflow-y-auto pr-1"
            >
              <legend className="sr-only">{t("Eligible Facebook Pages")}</legend>
              {selection.accounts.map((account: OAuthSelectionAccount) => {
                const isSelected = selectedAccountId === account.id;
                return (
                  <label
                    key={account.id}
                    className={cn(
                      "group flex cursor-pointer items-center justify-between gap-3 rounded-control border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                      isSelected
                        ? "border-ink bg-surface shadow-card ring-1 ring-ink/10"
                        : "border-line bg-page hover:bg-hover",
                    )}
                  >
                    <Input
                      type="radio"
                      name={`facebook-page-${selectionId}`}
                      value={account.id}
                      checked={isSelected}
                      onChange={() => setSelectedAccountId(account.id)}
                      className="sr-only"
                    />
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="size-10 shrink-0 border border-line">
                        <AvatarImage src={account.avatar_url ?? undefined} alt="" />
                        <AvatarFallback>
                          {(account.display_name?.slice(0, 2) ?? "FB").toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">
                          {account.display_name ?? t("Unnamed Page")}
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

          {actionError ? (
            <Alert variant="destructive" className="mt-3">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <p className="text-xs">{actionError}</p>
            </Alert>
          ) : null}
        </div>

        <CenterDialogFooter className="flex items-center justify-end gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {selectionUnavailable ? t("Close") : t("Cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            type="button"
            onClick={handleConfirm}
            disabled={
              !selectedAccountId ||
              isSubmitting ||
              selectionQuery.isLoading ||
              selectionQuery.isError ||
              !selection ||
              selection.accounts.length === 0
            }
            className="rounded-control font-medium text-xs"
          >
            {confirmMutation.isPending ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {t("Connecting…")}
              </span>
            ) : (
              t("Connect Page")
            )}
          </Button>
        </CenterDialogFooter>
      </CenterDialogContent>
    </CenterDialog>
  );
}

/**
 * Keeps the ticket form mounted through the shared bottom-popup exit animation.
 * A new ticket/open generation resets radio choice; all dismissal paths use the form's cancel mutation.
 */
export function FacebookPageSelectionDialog({
  open,
  onOpenChange,
  selectionId,
  onSuccess,
}: FacebookPageSelectionDialogProps) {
  const [session, setSession] = useState(() => ({ open, generation: 0, selectionId }));

  if (open !== session.open) {
    setSession({
      open,
      generation: open ? session.generation + 1 : session.generation,
      selectionId: open ? selectionId : session.selectionId,
    });
  } else if (open && selectionId !== session.selectionId) {
    setSession({ open, generation: session.generation + 1, selectionId });
  }

  return (
    <React.Fragment>
      {session.selectionId ? (
        <FacebookPageSelectionDialogContent
          key={session.generation}
          selectionId={session.selectionId}
          open={open}
          onClose={() => onOpenChange(false)}
          onSuccess={onSuccess}
        />
      ) : null}
    </React.Fragment>
  );
}
