import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { SidebarNav, type WorkspaceView } from "@/components/primitives/sidebar-nav";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";

interface MobileNavigationSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Phone/tablet navigation layer for below the 1024px rail breakpoint. It is the
 * same `SidebarNav` the desktop rail renders, positioned over the workspace as a
 * left-edge layer: a plain panel translated off the left edge with a fading
 * scrim, not a shared drawer primitive. Escape, the scrim, a destination, or a
 * viewport that grows past the rail breakpoint dismisses it; opening moves focus
 * into the panel and closing returns it to the opener. The shell marks the rest
 * of the workspace inert while the layer is open, so focus stays in the panel.
 */
export function MobileNavigationSidebar({
  open,
  onOpenChange,
  currentView,
  onNavigate,
}: MobileNavigationSidebarProps): React.ReactElement {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    previousFocusRef.current = previousFocus instanceof HTMLElement ? previousFocus : null;
    panelRef.current?.focus();
    /** Escape closes the layer, but a nested Radix menu owns the key while it is open. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="menu"], [role="listbox"]')) return;
      onOpenChange(false);
    };
    /** The desktop rail replaces this layer, so a resize past the breakpoint closes it. */
    const desktopRail = window.matchMedia("(min-width: 64rem)");
    const handleDesktopRail = () => {
      if (desktopRail.matches) onOpenChange(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    desktopRail.addEventListener("change", handleDesktopRail);
    handleDesktopRail();
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      desktopRail.removeEventListener("change", handleDesktopRail);
      const previousElement = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previousElement?.isConnected) previousElement.focus();
    };
  }, [open, onOpenChange]);

  return (
    <div
      data-lenis-prevent=""
      aria-hidden={!open}
      className={cn("fixed inset-0 z-50 lg:hidden", !open && "pointer-events-none")}
    >
      <div
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
        className={cn(
          "absolute inset-0 bg-overlay/60 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        ref={panelRef}
        id="mobile-navigation"
        role="dialog"
        aria-modal="true"
        aria-label={t("Workspace navigation")}
        tabIndex={-1}
        inert={!open}
        className={cn(
          "mobile-navigation-panel absolute inset-y-0 left-0 flex w-80 max-w-full flex-col overflow-hidden border-r border-line bg-canvas pt-(--safe-area-top) pb-(--safe-area-bottom) shadow-overlay outline-none",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mobile-navigation-close absolute right-2 z-10 size-8"
          aria-label={t("Close navigation menu")}
          onClick={() => onOpenChange(false)}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
        <SidebarNav
          currentView={currentView}
          onNavigate={onNavigate}
          collapsible={false}
          className="min-h-0 w-full border-r-0"
        />
      </div>
    </div>
  );
}
