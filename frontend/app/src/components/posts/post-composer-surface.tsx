import { lazy, Suspense, useMemo } from "react";
import { Skeleton } from "@meltiply/ui/skeleton";
import type { WorkspaceView } from "@/lib/navigation";
import { useI18n } from "@/lib/i18n";
import type { PostDrawerSurface } from "./posts-drawer";

/** Static import would load editing-only dependencies on every browsing entry; lazy owns that split. */
const Composer = lazy(async () => {
  const { Composer } = await import("@/components/composer/composer");
  return { default: Composer };
});

export interface PostComposerSurfaceProps {
  /** True while composing is the intent the panel should present. */
  open: boolean;
  /** Post being edited; a new composition when absent. */
  initialPostId?: string;
  /** Schedule seed from a calendar entry point. */
  initialDate?: Date;
  /** Session key: a new value starts a fresh composition without retaining a save. */
  sessionKey: number;
  onClose: () => void;
  onPostSuccess?: () => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Describes composing as the shared Posts panel presents it. The composer is the
 * panel's wide surface and owns its own pinned action bar, so it asks for a
 * wider panel and a body that bleeds to the panel's edges. Composing and
 * inspecting are alternatives in that one panel: opening the composer while a
 * Post is inspected swaps the panel in place instead of stacking drawers.
 *
 * @param props - Composition target, schedule seed, session key, and callbacks.
 * @returns The composer surface for the shared Posts panel.
 */
export function usePostComposerSurface({
  open,
  initialPostId,
  initialDate,
  sessionKey,
  onClose,
  onPostSuccess,
  onNavigate,
}: PostComposerSurfaceProps): PostDrawerSurface {
  const { t } = useI18n();

  return useMemo(
    () => ({
      open,
      // The session key restarts the body, so a new composition replays the rise.
      contentKey: `composer:${sessionKey}:${initialPostId ?? "new"}`,
      title: initialPostId ? t("Edit post") : t("New Post"),
      wide: true,
      onClose,
      body: (
        <Suspense
          fallback={
            <div role="status" className="flex flex-1 flex-col gap-4">
              <span className="sr-only">{t("Loading posts…")}</span>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          }
        >
          <Composer
            key={sessionKey}
            initialPostId={initialPostId}
            initialDate={initialDate}
            onPostSuccess={onPostSuccess}
            onNavigate={onNavigate}
          />
        </Suspense>
      ),
    }),
    [open, initialPostId, initialDate, sessionKey, onClose, onPostSuccess, onNavigate, t],
  );
}
