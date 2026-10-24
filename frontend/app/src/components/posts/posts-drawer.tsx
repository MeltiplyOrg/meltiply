import type React from "react";
import { useI18n } from "@/lib/i18n";
import { SideDialog } from "@meltiply/ui/side-dialog";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";

/**
 * One surface the Posts panel can present. Composing and inspecting are
 * alternatives rather than neighbours: the panel presents whichever surface the
 * current intent asks for, and switching between them morphs the panel's
 * content, width, and header in place instead of running one drawer out while
 * another runs in.
 *
 * A surface reports whether it is open and supplies its own header, geometry,
 * and body; each surface keeps its last real content while it closes, so
 * dismissal never blanks the panel mid-fade.
 */
export interface PostDrawerSurface {
  /** True while this surface is the one being asked for. */
  open: boolean;
  /** Identity of the shown content; a change replays the body's rise. */
  contentKey: string;
  title: string;
  description?: string;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Asks for the panel's wide geometry and edge-to-edge body, which composing
   * needs and inspecting does not.
   */
  wide?: boolean;
  /** Dismisses this surface without discarding the state it holds. */
  onClose: () => void;
  body: React.ReactNode;
}

export interface PostsDrawerProps {
  /** Inspector surface for the row the view is inspecting, or null with no rows. */
  detail: PostDrawerSurface | null;
  /**
   * Composer surface for the composition in progress. Pages that only inspect
   * Posts (the Queue calendar) omit it and open the same drawer for detail alone.
   */
  composer?: PostDrawerSurface | null;
  /**
   * Action rendered in the header's action cluster, ahead of the presented
   * surface's own actions. The open panel covers the page's create action, so
   * the view supplies its replacement here rather than leaving it unreachable.
   */
  headerAction?: React.ReactNode;
}

/**
 * Renders one edge drawer. Inspection takes presentation priority while a live
 * composition stays mounted in a hidden, inert section, preserving uploads and
 * local edits without browser-storage consent. Closing inspection returns to the
 * composition; explicitly closing the drawer releases both bodies after exit.
 *
 * @param props - The two alternative surfaces, each reporting whether it is open.
 * @returns The shared drawer, or null until a surface has been presented.
 */
export function PostsDrawer({
  detail,
  composer,
  headerAction,
}: PostsDrawerProps): React.ReactElement | null {
  const { t } = useI18n();
  // The latched value is which surface is shown, not the surface object itself:
  // descriptors are rebuilt as their data changes, and latching one would fight
  // that. Each surface keeps latching its own content.
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
