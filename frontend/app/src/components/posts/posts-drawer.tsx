import type React from "react";
import { useI18n } from "@/lib/i18n";
import { SideDialog } from "@meltiply/ui/side-dialog";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";

export interface PostDrawerSurface {
  open: boolean;
  contentKey: string;
  title: string;
  description?: string;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
  onClose: () => void;
  body: React.ReactNode;
}

export interface PostsDrawerProps {
  detail: PostDrawerSurface | null;
  composer?: PostDrawerSurface | null;
  headerAction?: React.ReactNode;
}

export function PostsDrawer({
  detail,
  composer,
  headerAction,
}: PostsDrawerProps): React.ReactElement | null {
  const { t } = useI18n();
  const requested = detail?.open ? "detail" : composer?.open ? "composer" : null;
  const shown = useLatchedValue(requested);
  const surface = shown === "composer" ? (composer ?? null) : shown === "detail" ? detail : null;
  if (!surface) return null;

  return (
    <SideDialog
      open={requested !== null}
      onOpenChange={(open) => !open && surface.onClose()}
      title={surface.title}
      description={surface.description}
      breadcrumb={surface.breadcrumb}
      actions={
        <>
          {headerAction}
          {surface.actions}
        </>
      }
      closeLabel={t("Close")}
      className={surface.wide ? "sm:max-w-260" : undefined}
      bodyClassName={surface.wide ? "flex flex-col pb-0 sm:pb-0" : undefined}
    >
      {composer && (composer.open || shown === "composer") && (
        <div
          key={composer.contentKey}
          data-side-dialog-section=""
          className={shown === "composer" ? "contents" : "hidden"}
          inert={shown !== "composer"}
        >
          {composer.body}
        </div>
      )}
      {shown === "detail" && detail && (
        <div key={detail.contentKey} data-side-dialog-section="" className="contents">
          {detail.body}
        </div>
      )}
    </SideDialog>
  );
}
