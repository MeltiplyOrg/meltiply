import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Menu, Search } from "lucide-react";
import { useWorkspace } from "@/context/workspace.context";
import {
  SidebarNav,
  SidebarNavRow,
  WORKSPACE_NAV_ITEMS,
  type WorkspaceView,
} from "@/components/primitives/sidebar-nav";
import { Button } from "@meltiply/ui/button";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Skeleton } from "@meltiply/ui/skeleton";
import { CenterDialog, CenterDialogContent, CenterDialogTitle } from "@meltiply/ui/center-dialog";
import { Toaster } from "@meltiply/ui/sileo";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { formatHotkey, hotkeys, useHotkey } from "@/lib/hotkeys";
import { useI18n } from "@/lib/i18n";
import { WorkspaceSearch } from "./workspace-search";
export type { WorkspaceView };

interface NavigationShellProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  children: ReactNode;
}

/**
 * Persistent Gr8r frame rewritten as Tailwind compositions: workspace rail,
 * 46px breadcrumb/search bar, and one full-height route viewport. Navigation
 * swaps real routes directly; no cloned slots, CSS page roles, or morph state.
 * Canonical dialogs own mobile/search focus trapping and dismissal.
 */
export function NavigationShell({ currentView, onNavigate, children }: NavigationShellProps) {
  const { selectedBrandProfile, isLoading: workspaceLoading } = useWorkspace();
  const { t } = useI18n();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useHotkey(hotkeys.commandMenu, () => setSearchOpen((open) => !open));
  /** Keeps mobile dismissal and URL navigation together for every real destination. */
  const handleNavClick = (view: WorkspaceView, options?: { search?: string }) => {
    onNavigate(view, options);
    setMobileMenuOpen(false);
  };
  const pageTitle =
    currentView === "posts"
      ? t("Posts")
      : currentView === "channels"
        ? t("Channels")
        : t("Settings");
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-page text-ink antialiased">
      <a
        href="#workspace-content"
        className="sr-only z-50 rounded-control border border-accent bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-2"
      >
        {t("Skip to content")}
      </a>
      <div className="hidden h-full shrink-0 lg:flex">
        <SidebarNav currentView={currentView} onNavigate={handleNavClick} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:h-topbar sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 lg:hidden"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t("Open navigation menu")}
          >
            <Menu className="size-4" />
          </Button>
          <BrandMark className="size-5 shrink-0 lg:hidden" />
          <nav aria-label={t("Breadcrumb")} className="flex min-w-0 items-center gap-2 text-xs">
            {workspaceLoading ? (
              <Skeleton className="hidden h-4 w-28 sm:block" aria-hidden="true" />
            ) : (
              <span className="hidden truncate text-ink-3 sm:inline">
                {selectedBrandProfile?.name ?? t("Workspace")}
              </span>
            )}
            <ChevronRight className="hidden size-3 shrink-0 text-ink-3 sm:block" />
            <span className="font-medium">{pageTitle}</span>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-line bg-inset font-normal text-ink-3 shadow-none"
              onClick={() => setSearchOpen(true)}
              aria-label={t("Search and jump to")}
            >
              <Search className="size-3.5" />
              <span className="hidden sm:inline">{t("Search or jump to…")}</span>
              <kbd className="ml-3 hidden font-mono text-(length:--font-size-micro) sm:inline">
                {formatHotkey(hotkeys.commandMenu)}
              </kbd>
            </Button>
          </div>
        </header>
        <CenterDialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <CenterDialogContent
            className="dialog-edge-panel fixed left-0 right-0 top-0 w-full max-w-none translate-x-0 translate-y-0 rounded-none rounded-b-window border-b border-line bg-canvas p-4 shadow-overlay sm:left-0 sm:top-0 lg:hidden"
            aria-describedby={undefined}
          >
            <CenterDialogTitle className="text-sm font-semibold">
              {t("Workspace navigation")}
            </CenterDialogTitle>
            <nav className="grid grid-cols-2 gap-2 pt-3">
              {WORKSPACE_NAV_ITEMS.map((item) => {
                const Icon = item.mobileIcon;
                return (
                  <SidebarNavRow
                    key={item.id}
                    active={currentView === item.id}
                    className="h-11"
                    onClick={() => handleNavClick(item.id)}
                    onMouseEnter={() => preloadDashboardRoute(item.id)}
                    onFocus={() => preloadDashboardRoute(item.id)}
                    aria-current={currentView === item.id ? "page" : undefined}
                  >
                    <Icon className="size-4" />
                    {t(item.label)}
                  </SidebarNavRow>
                );
              })}
            </nav>
          </CenterDialogContent>
        </CenterDialog>
        <main
          id="workspace-content"
          tabIndex={-1}
          data-lenis-prevent
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-surface"
        >
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col">{children}</div>
        </main>
      </div>
      <WorkspaceSearch open={searchOpen} onOpenChange={setSearchOpen} onNavigate={handleNavClick} />
      <Toaster />
    </div>
  );
}
