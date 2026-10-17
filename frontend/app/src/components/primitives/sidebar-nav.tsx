import { forwardRef, useState, type ComponentType } from "react";
import {
  ChevronDown,
  CircleHelp,
  LayoutGrid,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Search,
  Settings,
  Share2,
  UserRound,
} from "lucide-react";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { Button, type ButtonProps } from "@meltiply/ui/button";
import { toast } from "@meltiply/ui/toast";
import { cn } from "@meltiply/ui/utils";
import { useWorkspace } from "@/context/workspace.context";
import { useI18n } from "@/lib/i18n";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { POST_COLLECTION_MODES, POST_VIEW_OPTIONS } from "@/components/posts/post-view-options";

export type WorkspaceView = "posts" | "channels" | "settings";

/** Canonical real destinations shared by the rail, mobile drawer, and jump search. */
export interface WorkspaceNavItem {
  id: WorkspaceView;
  path: `/${WorkspaceView}`;
  label: string;
  icon: ComponentType<{ className?: string }>;
  mobileIcon: ComponentType<{ className?: string }>;
}

/** Reference demo routes are deliberately absent; every destination opens a real publishing surface. */
export const WORKSPACE_NAV_ITEMS: readonly WorkspaceNavItem[] = [
  { id: "posts", path: "/posts", label: "Posts", icon: PenSquare, mobileIcon: PenSquare },
  { id: "channels", path: "/channels", label: "Channels", icon: Share2, mobileIcon: Share2 },
  { id: "settings", path: "/settings", label: "Settings", icon: Settings, mobileIcon: Settings },
];

/** Resolves the first canonical route segment; unknown paths use the Posts home. */
export function resolveWorkspaceView(pathname: string): WorkspaceView {
  const segment = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return WORKSPACE_NAV_ITEMS.find((item) => item.path === `/${segment}`)?.id ?? "posts";
}

/** Returns the canonical URL for a supported workspace destination. */
export function workspaceViewPath(view: WorkspaceView): string {
  return WORKSPACE_NAV_ITEMS.find((item) => item.id === view)?.path ?? "/posts";
}

/** Reference navigation row shared by the desktop rail and mobile drawer; native button/Slot semantics stay intact. */
export const SidebarNavRow = forwardRef<
  HTMLButtonElement,
  ButtonProps & { collapsed?: boolean; active?: boolean }
>(({ collapsed = false, active = false, className, ...props }, ref) => (
  <Button
    ref={ref}
    variant="ghost"
    className={cn(
      "h-control w-full justify-start gap-2.25 px-2 text-left text-ui font-normal",
      collapsed && "justify-center px-0",
      active &&
        "bg-surface font-medium text-ink shadow-btn hover:bg-surface dark:bg-hover-2 dark:shadow-none dark:hover:bg-hover-2",
      className,
    )}
    {...props}
  />
));
SidebarNavRow.displayName = "SidebarNavRow";

export interface SidebarNavProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  onOpenSearch: () => void;
  className?: string;
}

const HEADING_CLASS =
  "mt-3.5 px-2 py-1.25 text-micro font-semibold uppercase tracking-wide text-ink-3";

/**
 * Gr8r's 252px/52px rail, rewritten in React/Tailwind. Real profile selection
 * scopes existing queries; all five collection shortcuts share toolbar metadata.
 * Collapse preserves named controls, and navigation has no snapshot/morph layer.
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
  /** Keeps a failed server sign-out visible instead of silently losing session errors. */
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
      className={cn(
        "flex h-full flex-col border-r border-line bg-canvas",
        collapsed ? "w-sidebar-collapsed" : "w-sidebar",
        className,
      )}
      aria-label={t("Workspace navigation")}
    >
      <div className="flex h-topbar shrink-0 items-center gap-2 px-3">
        <BrandMark className="size-5.5 shrink-0 text-ink" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-ui font-semibold" title={name}>
              {name}
            </span>
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
          </>
        )}
      </div>
      <nav className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {collapsed && (
          <SidebarNavRow
            collapsed
            className="mb-1"
            onClick={() => setCollapsed(false)}
            aria-label={t("Expand sidebar")}
            title={t("Expand sidebar")}
          >
            <PanelLeftOpen className="size-4" />
          </SidebarNavRow>
        )}
        <SidebarNavRow
          collapsed={collapsed}
          onClick={onOpenSearch}
          aria-label={t("Search and jump to")}
          title={collapsed ? t("Search") : undefined}
        >
          <Search className="size-4" />
          {!collapsed && t("Search")}
        </SidebarNavRow>
        {!collapsed && <div className={HEADING_CLASS}>{t("Workspace")}</div>}
        {WORKSPACE_NAV_ITEMS.map((item) => {
          if (item.id === "settings") return null;
          const Icon = item.icon;
          return (
            <div key={item.id} className="relative">
              <SidebarNavRow
                collapsed={collapsed}
                active={currentView === item.id}
                onClick={() => onNavigate(item.id)}
                onMouseEnter={() => preloadDashboardRoute(item.id)}
                onFocus={() => preloadDashboardRoute(item.id)}
                onPointerDown={() => preloadDashboardRoute(item.id)}
                aria-current={currentView === item.id ? "page" : undefined}
                aria-label={t(item.label)}
                title={collapsed ? t(item.label) : undefined}
              >
                <Icon className="size-4" />
                {!collapsed && <span>{t(item.label)}</span>}
              </SidebarNavRow>
              {!collapsed && item.id === "posts" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-5.5"
                  aria-label={t("Toggle {label} sub-navigation", { label: t("Posts") })}
                  aria-expanded={postsExpanded}
                  aria-controls="posts-sub-navigation"
                  onClick={() => setPostsExpanded(!postsExpanded)}
                >
                  <ChevronDown className={cn("size-3", !postsExpanded && "-rotate-90")} />
                </Button>
              )}
              {!collapsed && item.id === "posts" && postsExpanded && (
                <div
                  id="posts-sub-navigation"
                  className="mb-2 ml-4 mt-1 border-l border-line pl-2.25"
                >
                  {POST_COLLECTION_MODES.map((mode) => {
                    const ViewIcon = POST_VIEW_OPTIONS[mode].icon;
                    return (
                      <SidebarNavRow
                        key={mode}
                        className="h-7 text-control"
                        onClick={() => onNavigate("posts", { search: `view=${mode}` })}
                      >
                        <ViewIcon className="size-3.5" />
                        {t(POST_VIEW_OPTIONS[mode].label)}
                      </SidebarNavRow>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!collapsed && <div className={HEADING_CLASS}>{t("Brand Profiles")}</div>}
        <SidebarNavRow
          collapsed={collapsed}
          onClick={() => setSelectedBrandProfileId(null)}
          aria-pressed={selectedBrandProfileId === null}
          aria-label={t("All Brand Profiles")}
          title={collapsed ? t("All Brand Profiles") : undefined}
        >
          <LayoutGrid className="size-4" />
          {!collapsed && t("All Brand Profiles")}
        </SidebarNavRow>
        {brandProfiles.map((profile) => (
          <SidebarNavRow
            key={profile.id}
            collapsed={collapsed}
            active={selectedBrandProfileId === profile.id}
            onClick={() => setSelectedBrandProfileId(profile.id)}
            aria-pressed={selectedBrandProfileId === profile.id}
            aria-label={profile.name}
            title={collapsed ? profile.name : undefined}
          >
            <span
              className="flex size-4.5 shrink-0 items-center justify-center rounded-chip bg-accent-tint text-micro font-semibold text-accent-ink"
              aria-hidden="true"
            >
              {profile.name.slice(0, 1).toUpperCase()}
            </span>
            {!collapsed && <span className="truncate">{profile.name}</span>}
          </SidebarNavRow>
        ))}
      </nav>
      <div className="shrink-0 border-t border-line px-2 py-2">
        <SidebarNavRow asChild collapsed={collapsed}>
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
        </SidebarNavRow>
        <SidebarNavRow
          collapsed={collapsed}
          active={currentView === "settings"}
          onClick={() => onNavigate("settings")}
          onMouseEnter={() => preloadDashboardRoute("settings")}
          onFocus={() => preloadDashboardRoute("settings")}
          aria-label={t("Settings")}
          aria-current={currentView === "settings" ? "page" : undefined}
          title={collapsed ? t("Settings") : undefined}
        >
          <Settings className="size-4" />
          {!collapsed && t("Settings")}
        </SidebarNavRow>
        <div
          className={cn(
            "mt-2 flex gap-2 border-t border-line pt-2",
            collapsed ? "flex-col items-center" : "items-center",
          )}
        >
          <Avatar className="size-6 shrink-0">
            <AvatarImage src={user?.avatarUrl ?? undefined} alt="" />
            <AvatarFallback className="bg-accent-tint text-accent-ink">
              <UserRound className="size-3.5" />
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{user?.name || t("Creator")}</div>
              <div className="truncate text-micro text-ink-3">{user?.email}</div>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => void handleSignOut()}
            aria-label={t("Sign out")}
            title={t("Sign out")}
          >
            <LogOut className="size-3.5" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
