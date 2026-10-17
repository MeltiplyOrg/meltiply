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
  /** Composer surface for the composition in progress. */
  composer: PostDrawerSurface;
  /**
   * Action rendered in the header's action cluster, ahead of the presented
   * surface's own actions. The open panel covers the page's create action, so
   * the view supplies its replacement here rather than leaving it unreachable.
   */
  headerAction?: React.ReactNode;
}

/**
 * Renders the Posts page's single edge drawer and guarantees that at most one
 * surface is presented: the composer and the Post inspector share this panel, so
 * a click that asks for the other one swaps its content in place. The presented
 * surface stays latched through dismissal so the closing panel fades with its
 * content instead of emptying first.
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
  const requested = composer.open ? "composer" : detail?.open ? "detail" : null;
  const shown = useLatchedValue(requested);
  const surface = shown === "composer" ? composer : shown === "detail" ? detail : null;
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
      contentKey={surface.contentKey}
      closeLabel={t("Close")}
      className={surface.wide ? "sm:max-w-260" : undefined}
      bodyClassName={surface.wide ? "flex flex-col pb-0 sm:pb-0" : undefined}
    >
      {surface.body}
    </SideDialog>
  );
}
