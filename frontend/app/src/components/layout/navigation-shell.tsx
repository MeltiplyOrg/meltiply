import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Menu, Search } from "lucide-react";
import { useWorkspace } from "@/context/workspace.context";
import { SidebarNav } from "@/components/primitives/sidebar-nav";
import { workspaceNavItem, type WorkspaceView } from "@/lib/navigation";
import { Button } from "@meltiply/ui/button";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Skeleton } from "@meltiply/ui/skeleton";
import { MobileNavigationSidebar } from "./mobile-navigation-sidebar";
import { Toaster } from "@meltiply/ui/sileo";
import { formatHotkey, hotkeys, useHotkey } from "@/lib/hotkeys";
import { useI18n } from "@/lib/i18n";
import { WorkspaceSearch } from "./workspace-search";

interface NavigationShellProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  children: ReactNode;
}

/**
 * Persistent Gr8r frame rewritten as Tailwind compositions: workspace rail,
 * 46px breadcrumb/search bar, and one full-height route viewport. Navigation
 * swaps real routes directly; no cloned slots, CSS page roles, or morph state.
 * `MobileNavigationSidebar` owns the phone rail layer; the shared center dialog
 * owns jump-search focus and dismissal.
 */
export function NavigationShell({ currentView, onNavigate, children }: NavigationShellProps) {
  const { selectedBrandProfile, isLoading: workspaceLoading } = useWorkspace();
  const { t } = useI18n();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  useHotkey(hotkeys.commandMenu, () => setSearchOpen((open) => !open));
  /** Keeps mobile dismissal and URL navigation together for every real destination. */
  const handleNavClick = (view: WorkspaceView, options?: { search?: string }) => {
    onNavigate(view, options);
    setMobileMenuOpen(false);
  };
  const pageTitle = t(workspaceNavItem(currentView).label);
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-page pt-(--safe-area-top) pr-(--safe-area-right) pl-(--safe-area-left) text-ink antialiased">
      <a
        href="#workspace-content"
        inert={mobileMenuOpen}
        className="sr-only z-50 rounded-control border border-accent bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-2"
      >
        {t("Skip to content")}
      </a>
      <div inert={mobileMenuOpen} className="hidden h-full shrink-0 lg:flex">
        <SidebarNav currentView={currentView} onNavigate={handleNavClick} />
      </div>
      <div inert={mobileMenuOpen} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:h-topbar sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 lg:hidden"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t("Open navigation menu")}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation"
            aria-haspopup="dialog"
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
              ref={searchTriggerRef}
              variant="outline"
              size="sm"
              className="border-line bg-inset font-normal text-ink-3 shadow-none pointer-coarse:min-w-11"
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

        <main
          id="workspace-content"
          tabIndex={-1}
          data-lenis-prevent
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-surface"
        >
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col">{children}</div>
        </main>
      </div>
      <MobileNavigationSidebar
        open={mobileMenuOpen}
        onOpenChange={setMobileMenuOpen}
        currentView={currentView}
        onNavigate={handleNavClick}
      />
      <WorkspaceSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onNavigate={handleNavClick}
        fallbackFocusRef={searchTriggerRef}
      />
      <Toaster />
    </div>
  );
}
