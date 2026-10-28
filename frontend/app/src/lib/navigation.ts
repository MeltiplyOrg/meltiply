import type { ComponentType } from "react";
import { CalendarClock, ChartColumn, PenSquare, Settings, Share2 } from "lucide-react";
import { useLocation, useSearchParams as useRouterSearchParams } from "react-router";

/** A destination in the signed-in workspace; every value owns one implemented route. */
export type WorkspaceView = "posts" | "analytics" | "channels" | "queues" | "settings";

/**
 * Where a destination renders: `primary` rows live in the scrolling rail/list
 * group, while `utility` rows live in the pinned footer above account controls.
 */
export type WorkspaceNavPlacement = "primary" | "utility";

/** One canonical destination shared by the rail, mobile drawer, jump search, and header title. */
export interface WorkspaceNavItem {
  id: WorkspaceView;
  path: `/${WorkspaceView}`;
  label: string;
  icon: ComponentType<{ className?: string }>;
  placement: WorkspaceNavPlacement;
}

/**
 * Reference demo routes are deliberately absent; every destination opens a real
 * publishing surface. Queues is the implemented recurring publishing workflow
 * (not a Scheduled Posts filter), so it remains a primary destination. Settings
 * is a utility destination and renders through the same record instead of a
 * duplicate footer row.
 */
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

/**
 * Returns canonical destinations for one navigation placement, preserving the
 * roster's route order so the desktop rail, mobile drawer, and jump search agree.
 *
 * @param placement - `primary` destinations or the footer `utility` destination.
 * @returns Read-only items assigned to that placement.
 */
export function workspaceNavItems(placement: WorkspaceNavPlacement): readonly WorkspaceNavItem[] {
  return WORKSPACE_NAV_ITEMS.filter((item) => item.placement === placement);
}

/**
 * Returns the canonical item for a destination.
 *
 * @param view - Supported destination, or an unsupported runtime value.
 * @returns The matching item; Posts when the value is unknown, so callers never
 *   invent a route or label outside the canonical roster.
 */
export function workspaceNavItem(view: WorkspaceView): WorkspaceNavItem {
  return WORKSPACE_NAV_ITEMS.find((item) => item.id === view) ?? WORKSPACE_NAV_ITEMS[0]!;
}

/**
 * Resolves the first route segment to its canonical destination. Nested routes
 * such as `/channels/connect` and `/settings/account` belong to their parent;
 * unknown paths use the Posts home rather than guessing a destination.
 *
 * @param pathname - Current URL pathname (query and hash are not inspected).
 * @returns The owning destination, defaulting to `posts`.
 */
export function resolveWorkspaceView(pathname: string): WorkspaceView {
  const segment = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return WORKSPACE_NAV_ITEMS.find((item) => item.path === `/${segment}`)?.id ?? "posts";
}

/**
 * Returns the canonical URL for a supported workspace destination.
 *
 * @param view - Supported destination, or an unsupported runtime value.
 * @returns The canonical path, or `/posts` when the value is unknown.
 */
export function workspaceViewPath(view: WorkspaceView): string {
  return workspaceNavItem(view).path;
}

/**
 * Returns the current URL pathname from the React Router location.
 * Provides a Next.js-compatible hook interface over React Router's `useLocation`.
 *
 * @returns The current route pathname string (e.g. `/assets`, `/home`).
 */
export function usePathname(): string {
  return useLocation().pathname;
}

/**
 * Returns a read-only instance of the current query string's `URLSearchParams`.
 * Provides a Next.js-compatible hook interface over React Router's `useSearchParams`.
 *
 * @returns Current `URLSearchParams` object.
 */
export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}
