import { useEffect } from "react";
import { CenterDialog, NavigationDialogContent } from "@meltiply/ui/center-dialog";
import { SidebarNav, type WorkspaceView } from "@/components/primitives/sidebar-nav";
import { useI18n } from "@/lib/i18n";

interface MobileNavigationSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Reuses desktop SidebarNav below the 1024px rail breakpoint. The shared dialog
 * owns modal focus, nested Escape, scrim dismissal and left-edge motion; this
 * feature supplies destinations, localized labels and desktop-breakpoint closure.
 * The shell keeps its workspace inert until navigation is dismissed.
 */
export function MobileNavigationSidebar({
  open,
  onOpenChange,
  currentView,
  onNavigate,
}: MobileNavigationSidebarProps): React.ReactElement {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const desktopRail = window.matchMedia("(min-width: 64rem)");
    const handleDesktopRail = () => {
      if (desktopRail.matches) onOpenChange(false);
    };
    desktopRail.addEventListener("change", handleDesktopRail);
    handleDesktopRail();
    return () => desktopRail.removeEventListener("change", handleDesktopRail);
  }, [open, onOpenChange]);

  return (
    <CenterDialog open={open} onOpenChange={onOpenChange}>
      <NavigationDialogContent
        id="mobile-navigation"
        title={t("Workspace navigation")}
        closeLabel={t("Close navigation menu")}
      >
        <SidebarNav
          currentView={currentView}
          onNavigate={onNavigate}
          collapsible={false}
          className="min-h-0 w-full border-r-0"
        />
      </NavigationDialogContent>
    </CenterDialog>
  );
}
