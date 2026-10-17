import React, { useRef, useState } from "react";
import { LayoutGroup } from "motion/react";
import { ChevronRight, Menu, Search } from "lucide-react";
import { startWorkspaceSlotTransition } from "@/components/layout/workspace-slot-transition";
import { useWorkspace } from "@/context/workspace.context";
import {
  SidebarNav,
  WORKSPACE_NAV_ITEMS,
  type WorkspaceView,
} from "@/components/primitives/sidebar-nav";
import { Button } from "@meltiply/ui/button";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { CenterDialog, CenterDialogContent, CenterDialogTitle } from "@meltiply/ui/center-dialog";
import { Toaster } from "@meltiply/ui/sileo";
import { cn } from "@meltiply/ui/utils";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { formatHotkey, hotkeys, useHotkey } from "@/lib/hotkeys";
import { useI18n } from "@/lib/i18n";
import { WorkspaceSearch } from "./workspace-search";
import { WorkspaceSettings } from "./workspace-settings";
export type { WorkspaceView };

interface NavigationShellProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  children: React.ReactNode;
}

/**
 * Persistent Gr8r-adapted frame: warm sidebar, 46px breadcrumb/search bar,
 * aligned working area, and a mobile navigation drawer. Routes retain their
 * real publishing state. Shared dialogs own focus trapping/restoration; the
 * canonical shortcut opens the same jump palette from either navigation size.
 */
export function NavigationShell({ currentView, onNavigate, children }: NavigationShellProps) {
  const { selectedBrandProfile } = useWorkspace();
  const { t } = useI18n();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const workspaceContentRef = useRef<HTMLElement>(null);
  useHotkey(hotkeys.commandMenu, () => setSearchOpen((open) => !open));

  /** Snapshots route-shared toolbar slots before navigation; query-only changes retain live controls. */
  const handleNavClick = (view: WorkspaceView, options?: { search?: string }) => {
    if (view !== currentView) startWorkspaceSlotTransition(workspaceContentRef.current);
    onNavigate(view, options);
    setMobileMenuOpen(false);
  };

  return (
    <div className="flex h-screen h-dvh w-full overflow-hidden bg-page text-ink antialiased">
      <a href="#workspace-content" className="workspace-skip-link">
        {t("Skip to content")}
      </a>
      <div className="hidden lg:flex shrink-0 h-full">
        <SidebarNav
          currentView={currentView}
          onNavigate={handleNavClick}
          onOpenSearch={() => setSearchOpen(true)}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="workspace-topbar">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden shrink-0"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t("Open navigation menu")}
          >
            <Menu className="size-4" />
          </Button>
          <BrandMark className="size-5 shrink-0 lg:hidden" />
          <nav aria-label={t("Breadcrumb")} className="flex min-w-0 items-center gap-2 text-xs">
            <span className="truncate text-ink-3 hidden sm:inline">
              {selectedBrandProfile?.name ?? t("Workspace")}
            </span>
            <ChevronRight className="hidden size-3 shrink-0 text-ink-3 sm:block" />
            <span className="font-medium">{t(currentView === "posts" ? "Posts" : "Channels")}</span>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="workspace-topbar-search"
              onClick={() => setSearchOpen(true)}
              aria-label={t("Search and jump to")}
            >
              <Search className="size-3.5" />
              <span className="hidden sm:inline">{t("Search or jump to…")}</span>
              <kbd className="ml-3 hidden font-mono text-[10px] sm:inline">
                {formatHotkey(hotkeys.commandMenu)}
              </kbd>
            </Button>
            <WorkspaceSettings compact />
          </div>
        </header>
        <CenterDialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <CenterDialogContent
            className="dialog-edge-panel lg:hidden fixed top-0 left-0 right-0 translate-x-0 translate-y-0 max-w-none w-full rounded-none rounded-b-window border-b border-line bg-canvas p-4 shadow-overlay sm:left-0 sm:top-0"
            aria-describedby={undefined}
          >
            <CenterDialogTitle className="text-sm font-semibold">
              {t("Workspace navigation")}
            </CenterDialogTitle>
            <nav className="grid grid-cols-2 gap-2 pt-3">
              {WORKSPACE_NAV_ITEMS.map((item) => {
                const Icon = item.mobileIcon;
                return (
                  <Button
                    key={item.id}
                    variant="ghost"
                    onClick={() => handleNavClick(item.id)}
                    onMouseEnter={() => preloadDashboardRoute(item.id)}
                    onFocus={() => preloadDashboardRoute(item.id)}
                    aria-current={currentView === item.id ? "page" : undefined}
                    className={cn(
                      "h-11 justify-start",
                      currentView === item.id && "workspace-nav-active",
                    )}
                  >
                    <Icon className="size-4" />
                    {t(item.label)}
                  </Button>
                );
              })}
            </nav>
          </CenterDialogContent>
        </CenterDialog>
        <main
          id="workspace-content"
          tabIndex={-1}
          ref={workspaceContentRef}
          className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        >
          <LayoutGroup id="workspace-route-layout">
            <div className="flex h-full min-h-0 min-w-0 w-full flex-col">{children}</div>
          </LayoutGroup>
        </main>
      </div>
      <WorkspaceSearch open={searchOpen} onOpenChange={setSearchOpen} onNavigate={handleNavClick} />
      <Toaster />
    </div>
  );
}
