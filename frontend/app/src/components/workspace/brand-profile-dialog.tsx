import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  CenterAlertDialog,
  CenterAlertDialogAction,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogFooter,
  CenterDialogHeader,
  CenterDialogTitle,
} from "@meltiply/ui/center-dialog";
import { Input } from "@meltiply/ui/input";
import { BrandProfileColorPicker } from "@/components/workspace/brand-profile-color-picker";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useCreateBrandProfile, useDeleteBrandProfile, useUpdateBrandProfile } from "@/lib/queries";
import { useI18n } from "@/lib/i18n";
import { BRAND_PROFILE_COLORS, type BrandProfile, type BrandProfileColor } from "@/types";

export interface BrandProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile?: BrandProfile | null;
  onSuccess?: (profile: BrandProfile) => void;
  onDeleteSuccess?: (profileId: string) => void;
}

/**
 * Failure alert and action footer pinned to the dialog's scrollport bottom.
 *
 * The dialog keeps native whole-surface scrolling, so the 51-swatch palette can
 * extend far below a phone viewport. This opaque block keeps Delete, Cancel,
 * the primary action, and any mutation failure reachable without scrolling
 * first, while its normal flow position at the end of the content leaves the
 * final swatch fully visible at maximum scroll.
 *
 * It also republishes its live height as the dialog's `scroll-padding-bottom`.
 * Without that reserve, arrow-key navigation can focus a swatch underneath the
 * pinned block because the browser considers the swatch already in view. The
 * effect belongs to this child, not the form: Radix mounts the modal portal
 * after the form's first commit, so a form-level layout effect would run before
 * this node exists.
 *
 * @param props.children - The error alert and action footer to keep visible.
 * @returns Sticky wrapper carrying the pinned-region test hook.
 */
function BrandProfileDialogActions({ children }: { children: ReactNode }) {
  const regionRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const region = regionRef.current;
    const dialog = region?.closest<HTMLElement>('[role="dialog"]');
    if (!region || !dialog) return;

    const syncScrollPadding = () => {
      dialog.style.scrollPaddingBottom = `${region.offsetHeight}px`;
    };
    syncScrollPadding();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        dialog.style.scrollPaddingBottom = "";
      };
    }
    // The block grows when the failure alert appears and when coarse-pointer
    // buttons grow, so observe it rather than assuming one height.
    const observer = new ResizeObserver(syncScrollPadding);
    observer.observe(region);
    return () => {
      observer.disconnect();
      dialog.style.scrollPaddingBottom = "";
    };
  }, []);

  return (
    <div
      ref={regionRef}
      data-brand-profile-dialog-actions=""
      className="sticky bottom-0 z-20 -mx-4 flex flex-col gap-2.5 border-t border-line bg-surface px-4 pb-4 pt-3 sm:-mx-6 sm:px-6 sm:pb-6"
    >
      {children}
    </div>
  );
}
/**
 * Internal form presentation for Brand Profile creation and editing.
 *
 * Mounts freshly with initial drafts keyed on the dialog's open-session generation,
 * avoiding synchronous setState calls inside useEffect. In update mode, deletion
 * follows the app-wide destructive-confirmation pattern: a Delete button opens an
 * CenterAlertDialog whose action is the sole confirmation required to delete the profile.
 *
 * @param props.profile - Optional profile instance to update; omitted for creation.
 * @param props.onClose - Callback to dismiss the enclosing modal dialog.
 * @param props.onSuccess - Callback fired with the saved BrandProfile upon successful mutation.
 * @param props.onDeleteSuccess - Callback fired with the deleted profile ID upon deletion.
 * @returns React modal dialog content element.
 */
function BrandProfileDialogForm({
  profile,
  onClose,
  onSuccess,
  onDeleteSuccess,
}: {
  profile?: BrandProfile | null;
  onClose: () => void;
  onSuccess?: (profile: BrandProfile) => void;
  onDeleteSuccess?: (profileId: string) => void;
}) {
  const { t } = useI18n();
  const scope = useSessionScope();
  const { selectedBrandProfileId, setSelectedBrandProfileId } = useWorkspace();

  const createMutation = useCreateBrandProfile(scope);
  const updateMutation = useUpdateBrandProfile(scope);
  const deleteMutation = useDeleteBrandProfile(scope);

  const [name, setName] = useState(() => profile?.name ?? "");
  const [description, setDescription] = useState(() => profile?.description ?? "");
  const [color, setColor] = useState<BrandProfileColor>(
    () => profile?.color ?? BRAND_PROFILE_COLORS[0],
  );

  /** Controls the destructive-confirmation CenterAlertDialog for profile deletion. */
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const isEditing = Boolean(profile);
  const isSubmitting =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error ?? deleteMutation.error;
  // Pending copy names the lifecycle that is actually in flight; the footer keeps
  // the idle label until the owning mutation reports pending state.
  const submitLabel = isEditing
    ? updateMutation.isPending
      ? t("Updating…")
      : t("Update profile")
    : createMutation.isPending
      ? t("Creating…")
      : t("Create profile");

  /**
   * Submits the trimmed name, optional 280-character summary, and palette color
   * through the matching lifecycle mutation. Blank descriptions become null so
   * edit mode can explicitly clear a saved summary without storing whitespace.
   */
  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    const normalizedDescription = description.trim() || null;
    if (!trimmedName || isSubmitting) return;

    if (profile) {
      updateMutation.mutate(
        {
          profileId: profile.id,
          input: {
            name: trimmedName,
            description: normalizedDescription,
            color,
          },
        },
        {
          onSuccess: (saved) => {
            onSuccess?.(saved);
            onClose();
          },
        },
      );
    } else {
      createMutation.mutate(
        {
          name: trimmedName,
          description: normalizedDescription,
          color,
        },
        {
          onSuccess: (created) => {
            onSuccess?.(created);
            onClose();
          },
        },
      );
    }
  }, [
    name,
    description,
    color,
    profile,
    isSubmitting,
    updateMutation,
    createMutation,
    onSuccess,
    onClose,
  ]);

  /**
   * Deletes an existing profile once the CenterAlertDialog's confirm action fires.
   *
   * The guard rejects create mode and concurrent mutations. On success it clears the
   * matching global selection, reports the removed ID, and closes the editor.
   */
  const handleConfirmDelete = useCallback(() => {
    if (!profile || isSubmitting) return;

    deleteMutation.mutate(profile.id, {
      onSuccess: () => {
        if (selectedBrandProfileId === profile.id) {
          setSelectedBrandProfileId(null);
        }
        onDeleteSuccess?.(profile.id);
        onClose();
      },
    });
  }, [
    profile,
    isSubmitting,
    deleteMutation,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    onDeleteSuccess,
    onClose,
  ]);

  return (
    <CenterDialogContent closeLabel={t("Close")} className="pb-0 sm:pb-0">
      <CenterDialogHeader>
        <CenterDialogTitle>
          {isEditing ? t("Update Brand Profile") : t("Create Brand Profile")}
        </CenterDialogTitle>
        <CenterDialogDescription>
          {t(
            "Name, describe, and color-label the ownership scope for channels, assets, and posts.",
          )}
        </CenterDialogDescription>
      </CenterDialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <label htmlFor="brand-profile-dialog-name" className="text-xs font-semibold text-ink">
            {t("Profile name")}
          </label>
          <Input
            id="brand-profile-dialog-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={t("e.g. Acme Corp")}
            className="h-9 rounded-control border-line bg-page text-sm text-ink"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="brand-profile-dialog-description"
              className="text-xs font-semibold text-ink"
            >
              {t("Profile description")}
            </label>
            <span
              id="brand-profile-dialog-description-count"
              className="text-[11px] tabular-nums text-ink-3"
            >
              {description.length}/280
            </span>
          </div>
          <Input
            id="brand-profile-dialog-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={280}
            placeholder={t("Optional context for this profile")}
            aria-describedby="brand-profile-dialog-description-count"
            className="h-9 rounded-control border-line bg-page text-sm text-ink"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-ink">{t("Choose a profile color")}</label>
          <BrandProfileColorPicker
            value={color}
            onChange={setColor}
            label={t("Choose a profile color")}
          />
        </div>
      </div>

      {/*
        The palette is taller than a phone dialog, so the failure text and the
        actions share one sticky block at the scroll container's bottom edge.
        Native dialog scrolling is unchanged: the block reserves its own flow
        space at the end, which keeps the last swatch reachable at max scroll.
      */}
      <BrandProfileDialogActions>
        {mutationError ? (
          <p className="text-xs text-destructive" role="alert">
            {mutationError instanceof Error ? mutationError.message : t("Something went wrong")}
          </p>
        ) : null}

        <CenterDialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          {isEditing ? (
            <Button
              variant="destructive"
              size="sm"
              type="button"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={isSubmitting}
            >
              <Trash2 className="size-3.5" />
              {t("Delete profile")}
            </Button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              type="button"
              onClick={handleSave}
              disabled={!name.trim() || isSubmitting}
              className="rounded-control font-medium text-xs"
            >
              {submitLabel}
            </Button>
          </div>
        </CenterDialogFooter>
      </BrandProfileDialogActions>

      {/* Destructive confirmation; portals out as the top layer while open. */}
      <CenterAlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("Delete Brand Profile")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Deleting this Brand Profile permanently removes its posts and assets, disconnects its channels, and stops scheduled work. This cannot be undone.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel>{t("Cancel")}</CenterAlertDialogCancel>
            <CenterAlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? t("Deleting…") : t("Delete profile")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>
    </CenterDialogContent>
  );
}

/**
 * Shared modal dialog for creating or updating a Brand Profile with bottom-popup animation.
 *
 * Operates in two visual modes depending on the presence of `props.profile`:
 * - Update mode (profile provided): Renders "Update Brand Profile" title, pre-populates form
 *   drafts, shows an "Update profile" submit action, and provides a "Delete profile"
 *   button that deletes only after an CenterAlertDialog confirmation.
 * - Create mode (profile null/undefined): Renders "Create Brand Profile" with default values
 *   and creation submit action.
 * Uses the shared dialog's bottom-up entrance and bottom-down exit. The form stays
 * mounted across the close transition so Radix Presence can finish the exit
 * before removing the content from the DOM.
 * @param props.open - Controlled visibility state of the modal dialog.
 * @param props.onOpenChange - Visibility change callback.
 * @param props.profile - Optional profile instance to update; omitted for creation.
 * @param props.onSuccess - Callback fired with the saved BrandProfile upon successful mutation.
 * @param props.onDeleteSuccess - Callback fired with the deleted profile ID upon deletion.
 * @returns React modal dialog element.
 */
export function BrandProfileDialog({
  open,
  onOpenChange,
  profile,
  onSuccess,
  onDeleteSuccess,
}: BrandProfileDialogProps) {
  // Render-phase session tracking (React's "adjusting state during render" pattern): each
  // false→true open transition bumps `generation`, remounting the form with freshly seeded
  // drafts. Closing only records `open: false` — the key and the profile latched at open
  // time stay stable, so the mounted form plays the bottom-popup exit animation unchanged
  // even though callers clear `profile` the moment the dialog closes.
  const [session, setSession] = useState(() => ({ open, generation: 0, profile }));
  if (open !== session.open) {
    setSession({
      open,
      generation: open ? session.generation + 1 : session.generation,
      profile: open ? profile : session.profile,
    });
  } else if (open && (profile?.id ?? null) !== (session.profile?.id ?? null)) {
    // The dialog was retargeted to a different profile while still open: restart the
    // session so drafts re-seed from the new profile, matching the old key behavior.
    setSession({ open, generation: session.generation + 1, profile });
  }

  return (
    <CenterDialog open={open} onOpenChange={onOpenChange}>
      <BrandProfileDialogForm
        key={session.generation}
        profile={session.profile}
        onClose={() => onOpenChange(false)}
        onSuccess={onSuccess}
        onDeleteSuccess={onDeleteSuccess}
      />
    </CenterDialog>
  );
}
