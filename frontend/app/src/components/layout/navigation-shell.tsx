import React, { useRef, useState } from "react";
import { LayoutGroup } from "motion/react";
import { startWorkspaceSlotTransition } from "@/components/layout/workspace-slot-transition";
import { useWorkspace } from "@/context/workspace.context";
import {
  SidebarNav,
  WORKSPACE_NAV_ITEMS,
  type WorkspaceView,
} from "@/components/primitives/sidebar-nav";
import { Button } from "@meltiply/ui/button";
import { CenterDialog, CenterDialogContent, CenterDialogTitle } from "@meltiply/ui/center-dialog";
import { Toaster } from "@meltiply/ui/sileo";
import { LogOut, Menu } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { AccountSecurity } from "@/components/auth/account-security";
export type { WorkspaceView };

interface NavigationShellProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  children: React.ReactNode;
}

/**
 * Top-level responsive navigation shell providing the main application frame,
 * desktop collapsible sidebar, mobile navigation header and drawer, and view outlet.
 *
 * Both navigation surfaces derive from the canonical `WORKSPACE_NAV_ITEMS`
 * descriptor: the desktop `SidebarNav` renders the animated icon treatment and
 * the mobile drawer renders the same destinations with their static Lucide
 * icons, so labels and routes can never diverge. Before a cross-view sidebar
 * navigation, the persistent shell snapshots marked toolbar slots and projects
 * them into the destination toolbar, so shared controls morph without retaining
 * the full routed tree.
 * Mobile destinations warm on hover, focus, or pointer press, not on shell mount.
 *
 * Invariants:
 * - Automatically closes mobile menu drawer upon navigating to any view.
 * - Renders desktop sidebar on large breakpoints (`lg:flex`) and switches to mobile
 *   header/drawer overlay on smaller viewports.
 * - The mobile drawer uses the shared bottom-up dialog motion with edge-anchored
 *   geometry. Radix owns focus trapping, Escape dismissal, and scroll lock.
 *
 * @param props.currentView - Active workspace tab identifier controlling highlighted nav items.
 * @param props.onNavigate - Callback invoked with selected view id when navigation links are clicked.
 * @param props.children - Main view content rendered inside the animated, scrollable content canvas.
 */
export function NavigationShell({ currentView, onNavigate, children }: NavigationShellProps) {
  const { user, logout } = useWorkspace();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const workspaceContentRef = useRef<HTMLElement>(null);

  /**
   * Captures route-shared toolbar slots before changing workspace views, then
   * delegates navigation and closes the mobile drawer. Same-view query changes
   * skip the snapshot because their controls remain mounted in the current route.
   *
   * @param view - Requested destination workspace view.
   * @param options - Optional canonical route query string.
   */
  const handleNavClick = (view: WorkspaceView, options?: { search?: string }) => {
    if (view !== currentView) startWorkspaceSlotTransition(workspaceContentRef.current);
    onNavigate(view, options);
    setMobileMenuOpen(false);
  };

  return (
    <div className="flex h-screen h-dvh w-screen overflow-hidden bg-transparent text-ink antialiased">
      {/* Desktop Collapsible Sidebar */}
      <div className="hidden lg:flex shrink-0 h-full">
        <SidebarNav currentView={currentView} onNavigate={handleNavClick} />
      </div>

      {/* Main Column */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0 h-full">
        {/* Mobile Header */}
        <header className="lg:hidden flex h-14 items-center justify-between border-b border-line bg-surface/90 backdrop-blur-md px-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-control bg-foreground flex items-center justify-center text-background font-black text-xs">
              M
            </div>
            <span className="font-bold text-sm tracking-tight text-ink">MELTIPLY</span>
          </div>

          <div className="flex items-center gap-2">
            <AccountSecurity />
            <Button
              variant="outline"
              size="icon"
              className="size-8 rounded-control border-line"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="size-4" />
            </Button>
          </div>
        </header>

        {/* Mobile Navigation Drawer — CenterDialog owns focus trap, Escape, scroll lock */}
        <CenterDialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <CenterDialogContent
            className="dialog-edge-panel lg:hidden fixed top-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none w-full rounded-none rounded-b-window border-b border-line bg-surface p-4 flex flex-col gap-3 shadow-overlay sm:left-0 sm:top-0"
            aria-describedby={undefined}
          >
            <CenterDialogTitle className="sr-only">Navigation</CenterDialogTitle>
            <nav className="grid grid-cols-2 gap-1.5">
              {WORKSPACE_NAV_ITEMS.map((item) => {
                const Icon = item.mobileIcon;
                const isActive = currentView === item.id;
                return (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    onClick={() => handleNavClick(item.id)}
                    onMouseEnter={() => preloadDashboardRoute(item.id)}
                    onFocus={() => preloadDashboardRoute(item.id)}
                    onPointerDown={() => preloadDashboardRoute(item.id)}
                    className={cn(
                      "flex items-center justify-start gap-2 rounded-control px-2.5 py-2 text-[13px] font-medium transition-colors text-left",
                      // Active items pin hover colors so the ghost variant's
                      // default hover cannot repaint the active state.
                      isActive
                        ? "bg-foreground text-background font-semibold hover:bg-foreground hover:text-background"
                        : "text-ink-2 hover:bg-hover hover:text-ink",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Button>
                );
              })}
            </nav>
            <div className="pt-2 flex items-center justify-between border-t border-line-soft">
              <span className="text-xs text-ink-3 truncate">{user?.email}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  logout().catch(() => {});
                }}
                className="text-xs text-red hover:bg-red-tint hover:text-red"
              >
                <LogOut className="size-3.5 mr-1" /> Log out
              </Button>
            </div>
          </CenterDialogContent>
        </CenterDialog>

        {/* Main Content Area: persistent layout group coordinates route-surface morphs. */}
        <main
          ref={workspaceContentRef}
          className="flex-1 overflow-y-auto min-h-0 min-w-0 p-3 sm:p-5 lg:p-6 flex flex-col"
        >
          <LayoutGroup id="workspace-route-layout">
            <div className="w-full h-full flex flex-col min-h-0 min-w-0">{children}</div>
          </LayoutGroup>
        </main>
      </div>

      <Toaster />
    </div>
  );
}
