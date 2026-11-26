import { lazy, Suspense, useMemo } from "react";
import { Skeleton } from "@meltiply/ui/skeleton";
import type { WorkspaceView } from "@/lib/navigation";
import { useI18n } from "@/lib/i18n";
import type { PostDrawerSurface } from "./posts-drawer";

const Composer = lazy(async () => {
  const { Composer } = await import("@/components/composer/composer");
  return { default: Composer };
});

export interface PostComposerSurfaceProps {
  open: boolean;
  initialPostId?: string;
  initialDate?: Date;
  sessionKey: number;
  onClose: () => void;
  onPostSuccess?: () => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

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
