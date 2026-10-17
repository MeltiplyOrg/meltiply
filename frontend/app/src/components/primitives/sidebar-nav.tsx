import { forwardRef, useState, type ComponentType } from "react";
import {
  CircleHelp,
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Settings,
  Share2,
  Sun,
  UserRound,
} from "lucide-react";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { Button, type ButtonProps } from "@meltiply/ui/button";
import { useWorkspaceSignOut } from "@/hooks/use-workspace-sign-out";
import { cn } from "@meltiply/ui/utils";
import { useWorkspace } from "@/context/workspace.context";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";

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
>(({ collapsed = false, active = false, title, className, ...props }, ref) => {
  const row = (
    <Button
      ref={ref}
      variant="ghost"
      className={cn(
        "h-control w-full justify-start gap-2.25 px-2 text-left text-(length:--font-size-ui) font-normal",
        collapsed && "justify-center px-0",
        active &&
          "bg-surface font-medium text-ink shadow-btn hover:bg-surface dark:bg-hover-2 dark:shadow-none dark:hover:bg-hover-2",
        className,
      )}
      {...props}
    />
  );
  return title ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side={collapsed ? "right" : "bottom"}>{title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    row
  );
});
SidebarNavRow.displayName = "SidebarNavRow";

export interface SidebarNavProps {
  currentView: WorkspaceView;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  className?: string;
}

const HEADING_CLASS =
  "mt-3.5 px-2 py-1.25 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3";

const ACCOUNT_THEMES = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
] as const;

/** Shows the actual account image with the shared user-glyph fallback; caller sizing never changes identity. */
function AccountAvatar({ src, className }: { src?: string | null; className?: string }) {
  return (
    <Avatar className={cn("size-6 shrink-0", className)} aria-hidden="true">
      <AvatarImage src={src ?? undefined} alt="" />
      <AvatarFallback className="bg-accent-tint text-accent-ink">
        <UserRound className="size-3.5" />
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Gr8r's 252px/52px rail, rewritten in React/Tailwind. Posts and Channels are
 * single destinations; view selection and Brand Profile scope belong to their
 * page controls. Search lives in the top bar. The compact account row opens the
 * real identity/settings/sign-out menu with immediate shared theme preferences;
 * collapse preserves its accessible name.
 */
export function SidebarNav({ currentView, onNavigate, className }: SidebarNavProps) {
  const { user, workspaceName } = useWorkspace();
  const { t } = useI18n();
  const { requestedTheme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const name = workspaceName ?? "Meltiply Workspace";
  const handleSignOut = useWorkspaceSignOut();
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
            <span
              className="min-w-0 flex-1 truncate text-(length:--font-size-ui) font-semibold"
              title={name}
            >
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
            </div>
          );
        })}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarNavRow
              collapsed={collapsed}
              className="h-9"
              aria-label={t("Account menu")}
              title={collapsed ? t("Account menu") : undefined}
            >
              {/* The 24px identity avatar stays centered in the same 16px leading
                  column as every other row icon, so footer glyphs and labels share
                  one axis instead of the avatar pushing the name 8px right. */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                <AccountAvatar src={user?.avatarUrl} />
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {user?.name || t("Creator")}
                  </span>
                  <ChevronsUpDown className="size-3.25 shrink-0 text-ink-3" />
                </>
              )}
            </SidebarNavRow>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-65"
            aria-label={t("Account menu")}
          >
            <div className="flex min-w-0 items-center gap-2.5 px-2 pb-2.5 pt-2">
              <AccountAvatar src={user?.avatarUrl} className="size-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-(length:--font-size-ui) font-semibold">
                  {user?.name || t("Creator")}
                </div>
                <div className="truncate text-xs text-ink-3">{user?.email}</div>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onNavigate("settings", { search: "section=account" })}
            >
              <Settings className="size-3.75" />
              {t("Account settings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="px-2 pb-1 pt-1.5 text-(length:--font-size-micro) font-medium uppercase tracking-wide text-ink-3">
              {t("Theme")}
            </div>
            <DropdownMenuRadioGroup
              value={requestedTheme}
              onValueChange={(value) => {
                const theme = ACCOUNT_THEMES.find((option) => option.value === value);
                if (theme) setTheme(theme.value);
              }}
              aria-label={t("Theme")}
              className="mx-1.5 mb-1.5 flex gap-0.5 rounded-control bg-hover-2 p-0.5"
            >
              {ACCOUNT_THEMES.map(({ value, icon: Icon }) => (
                <DropdownMenuRadioItem
                  key={value}
                  value={value}
                  variant="segment"
                  onSelect={(event) => event.preventDefault()}
                >
                  <Icon className="size-3.25" aria-hidden="true" />
                  {value === "light" ? t("Light") : value === "dark" ? t("Dark") : t("System")}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleSignOut()}>
              <LogOut className="size-3.75" />
              {t("Sign out")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
