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

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const isEditing = Boolean(profile);
  const isSubmitting =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error ?? deleteMutation.error;
  const submitLabel = isEditing
    ? updateMutation.isPending
      ? t("Updating…")
      : t("Update profile")
    : createMutation.isPending
      ? t("Creating…")
      : t("Create profile");

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

      <CenterAlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("Delete Brand Profile")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Deleting this Brand Profile permanently deletes its posts and asset records and disconnects its channels. Scheduled and queued work is cancelled, but attempts already running on a platform may still publish. This cannot be undone.",
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

export function BrandProfileDialog({
  open,
  onOpenChange,
  profile,
  onSuccess,
  onDeleteSuccess,
}: BrandProfileDialogProps) {
  const [session, setSession] = useState(() => ({ open, generation: 0, profile }));
  if (open !== session.open) {
    setSession({
      open,
      generation: open ? session.generation + 1 : session.generation,
      profile: open ? profile : session.profile,
    });
  } else if (open && (profile?.id ?? null) !== (session.profile?.id ?? null)) {
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
