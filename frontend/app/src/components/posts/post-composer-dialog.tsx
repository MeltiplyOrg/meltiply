import { Composer } from "@/components/composer/composer";
import type { WorkspaceView } from "@/components/layout/navigation-shell";
import { useI18n } from "@/lib/i18n";
import { SideDialog } from "@meltiply/ui/side-dialog";

export interface PostComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Post to edit; a new composition when absent. */
  initialPostId?: string;
  /** Schedule seed from a calendar entry point. */
  initialDate?: Date;
  /** Session key: a new value starts a fresh composition without retaining a save. */
  sessionKey: number;
  onPostSuccess?: () => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Hosts the Post composer inside the shared edge drawer, so composing, scheduling,
 * and publishing are live in the same surface as inspection instead of a separate
 * composer page. The composer's own Save/Schedule/Publish actions stay in its body;
 * the drawer supplies the title, Close, and scrolling. The composer therefore ships
 * with the Posts chunk rather than a separate lazily loaded one.
 *
 * @param props - Post identity, schedule seed, composition session key, and callbacks.
 * @returns The composer drawer.
 */
export function PostComposerDialog({
  open,
  onOpenChange,
  initialPostId,
  initialDate,
  sessionKey,
  onPostSuccess,
  onNavigate,
}: PostComposerDialogProps) {
  const { t } = useI18n();

  return (
    <SideDialog
      open={open}
      onOpenChange={onOpenChange}
      title={initialPostId ? t("Edit post") : t("New Post")}
      contentKey={`${sessionKey}:${initialPostId ?? "new"}`}
      closeLabel={t("Close")}
      bodyClassName="flex flex-col pb-0 sm:pb-0"
    >
      <Composer
        key={sessionKey}
        initialPostId={initialPostId}
        initialDate={initialDate}
        onPostSuccess={onPostSuccess}
        onNavigate={onNavigate}
      />
    </SideDialog>
  );
}
