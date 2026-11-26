import { useCallback, type ComponentType } from "react";
import { CalendarClock, ChartColumn, PenSquare, Settings, Share2 } from "lucide-react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router";

const leadingSlashPattern = /^\//;

export type WorkspaceView = "posts" | "analytics" | "channels" | "queues" | "settings";

export type WorkspaceNavPlacement = "primary" | "utility";

export interface WorkspaceNavItem {
  id: WorkspaceView;
  path: `/${WorkspaceView}`;
  label: string;
  icon: ComponentType<{ className?: string }>;
  placement: WorkspaceNavPlacement;
}

export const WORKSPACE_NAV_ITEMS: readonly WorkspaceNavItem[] = [
  { id: "posts", path: "/posts", label: "Posts", icon: PenSquare, placement: "primary" },
  {
    id: "analytics",
    path: "/analytics",
    label: "Analytics",
    icon: ChartColumn,
    placement: "primary",
  },
  { id: "channels", path: "/channels", label: "Channels", icon: Share2, placement: "primary" },
  { id: "queues", path: "/queues", label: "Queues", icon: CalendarClock, placement: "primary" },
  { id: "settings", path: "/settings", label: "Settings", icon: Settings, placement: "utility" },
];

export function workspaceNavItems(placement: WorkspaceNavPlacement): readonly WorkspaceNavItem[] {
  return WORKSPACE_NAV_ITEMS.filter((item) => item.placement === placement);
}

export function workspaceNavItem(view: WorkspaceView): WorkspaceNavItem {
  return WORKSPACE_NAV_ITEMS.find((item) => item.id === view) ?? WORKSPACE_NAV_ITEMS[0]!;
}

export function resolveWorkspaceView(pathname: string): WorkspaceView {
  const segment = pathname.replace(leadingSlashPattern, "").split("/")[0] ?? "";
  return WORKSPACE_NAV_ITEMS.find((item) => item.path === `/${segment}`)?.id ?? "posts";
}

export function workspaceViewPath(view: WorkspaceView): string {
  return workspaceNavItem(view).path;
}

export function useWorkspaceNavigate(): (
  view: WorkspaceView,
  options?: { search?: string },
) => void {
  const navigate = useNavigate();
  return useCallback(
    (view, options) => {
      const search = options?.search ?? "";
      const query = !search || search.startsWith("?") ? search : `?${search}`;
      void navigate(`${workspaceViewPath(view)}${query}`);
    },
    [navigate],
  );
}

export function sameOriginPath(requested: string | null): string | null {
  if (!requested?.startsWith("/")) return null;
  const base = "https://meltiply.invalid";
  if (!URL.canParse(requested, base)) return null;
  const url = new URL(requested, base);
  if (url.origin !== base || url.pathname.startsWith("//")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}
