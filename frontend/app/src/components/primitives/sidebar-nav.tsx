import { useState } from "react";
import type { ComponentType } from "react";
import {
  CalendarDays,
  ChevronDown,
  CircleHelp,
  LayoutGrid,
  List,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Search,
  Share2,
  UserRound,
} from "lucide-react";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { Button } from "@meltiply/ui/button";
import { toast } from "@meltiply/ui/toast";
import { cn } from "@meltiply/ui/utils";
import { useWorkspace } from "@/context/workspace.context";
import { useI18n } from "@/lib/i18n";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { WorkspaceSettings } from "@/components/layout/workspace-settings";

export type WorkspaceView = "posts" | "channels";

/** Canonical destinations shared by the desktop rail, mobile drawer, and jump search. */
export interface WorkspaceNavItem {
  id: WorkspaceView;
  path: `/${WorkspaceView}`;
  label: string;
  icon: ComponentType<{ className?: string }>;
  mobileIcon: ComponentType<{ className?: string }>;
}

/** Only supported publishing surfaces belong in navigation; reference demo routes are not copied. */
export const WORKSPACE_NAV_ITEMS: readonly WorkspaceNavItem[] = [
  { id: "posts", path: "/posts", label: "Posts", icon: PenSquare, mobileIcon: PenSquare },
  { id: "channels", path: "/channels", label: "Channels", icon: Share2, mobileIcon: Share2 },
];

/** Resolves the first canonical path segment; unknown paths use the Posts home. */
export function resolveWorkspaceView(pathname: string): WorkspaceView {
  const segment = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return WORKSPACE_NAV_ITEMS.find((item) => item.path === `/${segment}`)?.id ?? "posts";
}

/** Returns the canonical URL for a supported workspace view. */
export function workspaceViewPath(view: WorkspaceView): string {
  return WORKSPACE_NAV_ITEMS.find((item) => item.id === view)?.path ?? "/posts";
}

export interface SidebarNavProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  onOpenSearch: () => void;
  className?: string;
}

/**
 * Gr8r-style 252px workspace rail with a 52px collapsed mode. Real Brand Profiles
 * replace the reference's projects; selecting one scopes existing Posts/Channels
 * queries. Workspace identity stays read-only. Navigation is instant, labels stay
 * attached to their controls, and collapsed actions retain accessible names.
 */
export function SidebarNav({ currentView, onNavigate, onOpenSearch, className }: SidebarNavProps) {
  const {
    user,
    workspaceName,
    brandProfiles,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    logout,
  } = useWorkspace();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [postsExpanded, setPostsExpanded] = useState(true);
  const name = workspaceName ?? "Meltiply Workspace";
  /** Retains visible recovery when the server cannot end the current session. */
  const handleSignOut = async () => {
    try {
      await logout();
    } catch {
      toast(t("Could not sign out"), {
        description: t("Try again to end your session."),
        variant: "error",
      });
    }
  };
  return (
    <aside
      className={cn("workspace-sidebar", collapsed && "workspace-sidebar-collapsed", className)}
      aria-label={t("Workspace navigation")}
    >
      <div className="flex h-[46px] shrink-0 items-center gap-2 px-3">
        <BrandMark className="size-[22px] shrink-0 text-ink" />
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold" title={name}>
            {name}
          </span>
        )}
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => setCollapsed(true)}
            aria-label={t("Collapse sidebar")}
            title={t("Collapse sidebar")}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 hide-scrollbar">
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="mb-1 w-full"
            onClick={() => setCollapsed(false)}
            aria-label={t("Expand sidebar")}
            title={t("Expand sidebar")}
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          className="workspace-nav-row"
          onClick={onOpenSearch}
          aria-label={t("Search and jump to")}
          title={collapsed ? t("Search") : undefined}
        >
          <Search className="size-4 shrink-0" />
          {!collapsed && <span>{t("Search")}</span>}
        </Button>
        {!collapsed && <div className="workspace-nav-heading">{t("Workspace")}</div>}
        {WORKSPACE_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.id} className="relative">
              <Button
                variant="ghost"
                onClick={() => onNavigate(item.id)}
                onMouseEnter={() => preloadDashboardRoute(item.id)}
                onFocus={() => preloadDashboardRoute(item.id)}
                onPointerDown={() => preloadDashboardRoute(item.id)}
                aria-current={currentView === item.id ? "page" : undefined}
                aria-label={t(item.label)}
                title={collapsed ? t(item.label) : undefined}
                className={cn(
                  "workspace-nav-row",
                  currentView === item.id && "workspace-nav-active",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span>{t(item.label)}</span>}
              </Button>
              {!collapsed && item.id === "posts" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-[22px]"
                  aria-label={t("Toggle {label} sub-navigation", { label: t("Posts") })}
                  aria-expanded={postsExpanded}
                  aria-controls="posts-sub-navigation"
                  onClick={() => setPostsExpanded(!postsExpanded)}
                >
                  <ChevronDown className={cn("size-3", !postsExpanded && "-rotate-90")} />
                </Button>
              )}
              {!collapsed && item.id === "posts" && postsExpanded && (
                <div id="posts-sub-navigation" className="workspace-sub-navigation">
                  <Button
                    variant="ghost"
                    className="workspace-nav-row"
                    onClick={() => onNavigate("posts", { search: "view=list" })}
                  >
                    <List className="size-3.5" />
                    {t("List")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="workspace-nav-row"
                    onClick={() => onNavigate("posts", { search: "view=grid" })}
                  >
                    <LayoutGrid className="size-3.5" />
                    {t("Grid")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="workspace-nav-row"
                    onClick={() => onNavigate("posts", { search: "view=calendar" })}
                  >
                    <CalendarDays className="size-3.5" />
                    {t("Calendar")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {!collapsed && <div className="workspace-nav-heading">{t("Brand Profiles")}</div>}
        <Button
          variant="ghost"
          className={cn("workspace-nav-row", selectedBrandProfileId === null && "text-ink")}
          onClick={() => setSelectedBrandProfileId(null)}
          aria-pressed={selectedBrandProfileId === null}
          aria-label={t("All Brand Profiles")}
          title={collapsed ? t("All Brand Profiles") : undefined}
        >
          <LayoutGrid className="size-4 shrink-0" />
          {!collapsed && <span>{t("All Brand Profiles")}</span>}
        </Button>
        {brandProfiles.map((profile) => (
          <Button
            key={profile.id}
            variant="ghost"
            className={cn(
              "workspace-nav-row",
              selectedBrandProfileId === profile.id && "workspace-nav-active",
            )}
            onClick={() => setSelectedBrandProfileId(profile.id)}
            aria-pressed={selectedBrandProfileId === profile.id}
            aria-label={profile.name}
            title={collapsed ? profile.name : undefined}
          >
            <span
              className="flex size-[18px] shrink-0 items-center justify-center rounded-chip bg-accent-tint text-[10px] font-semibold text-accent-ink"
              aria-hidden="true"
            >
              {profile.name.slice(0, 1).toUpperCase()}
            </span>
            {!collapsed && <span className="truncate">{profile.name}</span>}
          </Button>
        ))}
      </nav>
      <div className="shrink-0 border-t border-line px-2 py-2">
        <Button asChild variant="ghost" className="workspace-nav-row">
          <a
            href="https://meltiply.com/docs"
            target="_blank"
            rel="noreferrer"
            aria-label={t("Help and resources")}
            title={collapsed ? t("Help and resources") : undefined}
          >
            <CircleHelp className="size-4" />
            {!collapsed && t("Help and resources")}
          </a>
        </Button>
        <WorkspaceSettings compact={collapsed} />
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
          <Avatar className="size-6 shrink-0">
            <AvatarImage src={user?.avatarUrl ?? undefined} alt="" />
            <AvatarFallback className="bg-accent-tint text-accent-ink">
              <UserRound className="size-3.5" />
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{user?.name || t("Creator")}</div>
              <div className="truncate text-[11px] text-ink-3">{user?.email}</div>
            </div>
          )}
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              onClick={() => {
                void handleSignOut();
              }}
              aria-label={t("Sign out")}
              title={t("Sign out")}
            >
              <LogOut className="size-3.5" />
            </Button>
          )}
        </div>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="mt-1 w-full"
            onClick={() => {
              void handleSignOut();
            }}
            aria-label={t("Sign out")}
            title={t("Sign out")}
          >
            <LogOut className="size-4" />
          </Button>
        )}
      </div>
    </aside>
  );
}
