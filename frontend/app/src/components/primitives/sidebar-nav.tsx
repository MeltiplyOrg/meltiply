import React, { useState, useRef, useId } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@meltiply/ui/utils";
import { useWorkspace } from "@/context/workspace.context";
import { useTheme } from "@/lib/theme";
import { themeOriginFromEvent } from "@meltiply/ui/theme-transition";
import { ThemeIcon, MotionIcon } from "@meltiply/ui/preference-icons";
import { useI18n } from "@/lib/i18n";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
import { preloadDashboardRoute } from "@/lib/preload-routes";
import {
  AnimatedSquarePen,
  AnimatedShare,
  AnimatedSearch,
  AnimatedChevronDown,
  AnimatedCollapseToggle,
  AnimatedLogOut,
  AnimatedX,
  AnimatedLayoutGrid,
} from "@meltiply/ui/animated-icons";
import { PenSquare, Share2, UserRound } from "lucide-react";
import { BrandMark } from "@meltiply/ui/brand-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@meltiply/ui/avatar";
import { SidebarGlideHighlight } from "@meltiply/ui/sidebar-glide-highlight";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";

/**
 * Motion-wrapped canonical Button: `motion.create` forwards every `ButtonProps`
 * prop through Radix-compatible slot props, so the wrapped control keeps the
 * shared variant/size classes while gaining `initial`/`animate`/`exit` support.
 * Used only where a control must animate its own mount, unmount, or geometry —
 * static controls stay plain `Button` to avoid needless Motion overhead.
 */
const MotionButton = motion.create(Button);

/**
 * Identifier union of all navigable top-level workspace views.
 * Each member maps one-to-one to a canonical route in `app-router.tsx`.
 */
export type WorkspaceView = "posts" | "channels";

/**
 * Specification for a secondary sub-navigation item.
 */
interface NavSubItem {
  /** Unique sub-item identifier. */
  id: string;
  /** Display text label. */
  label: string;
  /** Icon component with animation support. */
  icon: React.ComponentType<{ className?: string; isHovered?: boolean }>;
  /** Target workspace view. */
  view: WorkspaceView;
}

/**
 * Specification for a single primary sidebar navigation item.
 */
interface NavItem {
  /** Unique view identifier matched against active `currentView`. */
  id: WorkspaceView;
  /** Display text in expanded sidebar mode and accessibility title tooltip. */
  label: string;
  /** Animated icon component rendered in the navigation row. */
  icon: React.ComponentType<{ className?: string; isHovered?: boolean }>;
  /** Optional badge indicator label (e.g. 'AI'). */
  badge?: string;
  /** Optional nested sub-navigation destinations. */
  subItems?: NavSubItem[];
}

/**
 * Canonical workspace navigation descriptor — the single source of truth for
 * view id, canonical route path, label, and per-surface iconography.
 *
 * The desktop sidebar consumes `icon` (animated icons with hover states) while
 * the mobile drawer consumes `mobileIcon` (static Lucide glyphs); both derive
 * from this list so labels and destinations can never diverge. `path` is the
 * canonical route segment (`/${view}`) used by `workspaceViewPath` and
 * `resolveWorkspaceView` to translate between URLs and view identifiers.
 */
export interface WorkspaceNavItem {
  /** Workspace view identifier, equal to the canonical route segment. */
  id: WorkspaceView;
  /** Canonical route path for the view (e.g. `/posts`). */
  path: `/${WorkspaceView}`;
  /** Display label shared by desktop and mobile navigation. */
  label: string;
  /** Animated icon rendered by the desktop sidebar. */
  icon: React.ComponentType<{ className?: string; isHovered?: boolean }>;
  /** Static Lucide icon rendered by the mobile navigation drawer. */
  mobileIcon: React.ComponentType<{ className?: string }>;
  /** Optional badge indicator label (e.g. 'AI'). */
  badge?: string;
  /** Optional nested sub-navigation destinations (desktop sidebar only). */
  subItems?: NavSubItem[];
}

/**
 * Ordered descriptor of every workspace surface. Order defines both the
 * desktop sidebar and mobile drawer ordering; `path` is the only route each
 * view is reachable at — retired aliases resolve nowhere.
 */
export const WORKSPACE_NAV_ITEMS: readonly WorkspaceNavItem[] = [
  {
    id: "channels",
    path: "/channels",
    label: "Channels",
    icon: AnimatedShare,
    mobileIcon: Share2,
  },
  {
    id: "posts",
    path: "/posts",
    label: "Posts",
    icon: AnimatedSquarePen,
    mobileIcon: PenSquare,
    subItems: [{ id: "overview", label: "Overview", icon: AnimatedLayoutGrid, view: "posts" }],
  },
];

/**
 * Resolves a URL pathname to its workspace view identifier by matching the
 * first path segment against the canonical `WORKSPACE_NAV_ITEMS` paths.
 * Unknown segments fall back to `posts`, the workspace home surface.
 *
 * @param pathname - Current location pathname (e.g. `/channels`, `/posts`).
 * @returns The matching `WorkspaceView` identifier.
 */
export function resolveWorkspaceView(pathname: string): WorkspaceView {
  const segment = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return WORKSPACE_NAV_ITEMS.find((item) => item.path === `/${segment}`)?.id ?? "posts";
}

/**
 * Maps a workspace view identifier to its canonical route path.
 *
 * @param view - Target workspace view.
 * @returns Canonical pathname for the view (e.g. `posts` → `/posts`).
 */
export function workspaceViewPath(view: WorkspaceView): string {
  return WORKSPACE_NAV_ITEMS.find((item) => item.id === view)?.path ?? "/posts";
}

/**
 * Configuration properties for the `SidebarNav` root navigation component.
 */
export interface SidebarNavProps {
  /** Currently active workspace view identifier. */
  currentView: WorkspaceView;
  /** Callback invoked when the user selects a navigation row or view trigger. */
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
  /** Optional callback invoked when selecting a recent post item. */
  onSelectRecent?: (postId: string) => void;
  /** Additional CSS class names applied to the root `<aside>` container. */
  className?: string;
}

/**

 * Properties for the quick search input / toggle button inside the sidebar.
 */
interface QuickSearchProps {
  /** Whether the parent sidebar is currently collapsed to icon-only mode. */
  collapsed: boolean;
  /** Whether the inline search text field is active and expanded. */
  searchOpen: boolean;
  /** Current search query string filter. */
  searchQuery: string;
  /** React ref to the search input element for imperative autofocus. */
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** Callback to activate inline search mode. */
  onOpenSearch: () => void;
  /** Callback to close inline search mode and clear query. */
  onCloseSearch: () => void;
  /** Callback when the search filter input text changes. */
  onChangeQuery: (query: string) => void;
}

/**
 * Renders either a compact/expanded search trigger button or an inline search input
 * allowing quick filtering of sidebar navigation links with valid theme-scale keyboard-hint spacing.
 * Under the shared low-motion preference (manual or OS), the label reveal mounts and
 * unmounts at its resting geometry with zero transition duration instead of sliding
 * from `x: -4`, so collapse/expand never produces visible travel or a delayed exit.
 * All controls use the shared `Button`/`Input` wrappers; the icon-only close
 * carries a localized accessible name since its glyph is decorative-only.

 * @param props - Search state flags, text query, and toggle handlers.
 * @returns Quick search button or active input element.
 */
function QuickSearch({
  collapsed,
  searchOpen,
  searchQuery,
  searchInputRef,
  onOpenSearch,
  onCloseSearch,
  onChangeQuery,
}: QuickSearchProps) {
  const { lowMotion } = useMotionPreference();
  const { t } = useI18n();
  if (searchOpen && !collapsed) {
    return (
      <div className="px-2 py-1">
        <div className="relative flex items-center">
          <AnimatedSearch className="absolute left-2.5 size-3.5 text-ink-3 pointer-events-none" />
          <Input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onChangeQuery(e.target.value)}
            placeholder={t("Jump to...")}
            aria-label={t("Jump to...")}
            className="h-8 w-full rounded-control border-line bg-page pl-8 pr-7 text-[13px] text-ink placeholder:text-ink-3 focus:border-line-strong"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCloseSearch}
            aria-label={t("Clear search")}
            className="absolute right-2 size-6 rounded-control p-0 text-ink-3 hover:bg-transparent hover:text-ink"
          >
            <AnimatedX className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpenSearch}
        className="h-8 w-full justify-start gap-0 rounded-control border-line/60 bg-page/60 px-1.5 text-left text-[13px] font-normal text-ink-3 hover:border-line hover:bg-hover hover:text-ink overflow-hidden"
        title={collapsed ? "Search" : undefined}
      >
        <span className="flex size-7 shrink-0 items-center justify-center">
          <AnimatedSearch className="size-3.5" />
        </span>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={lowMotion ? false : { opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
              transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="ml-1.5 flex flex-1 items-center justify-between overflow-hidden"
            >
              <span>{t("Search")}</span>
              <span className="font-mono text-[10.5px] rounded border border-line bg-surface px-1 py-0.5 text-ink-3">
                ⌘K
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </Button>
    </div>
  );
}

interface SidebarNavItemRowProps {
  item: NavItem;
  currentView: WorkspaceView;
  collapsed: boolean;
  hoveredNavId: WorkspaceView | null;
  postsExpanded: boolean;
  onHover: (id: WorkspaceView | null) => void;
  onTogglePosts: () => void;
  onNavigate: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Renders a single sidebar navigation row or expandable section with nested destinations.
 * Under the shared low-motion preference, the label reveal and expandable sub-item accordion
 * snap directly to their resting geometry with zero transition duration.
 * Hover, keyboard focus, and pointer press warm only this row's destination.
 * Posts sub-navigation reflects the current view, not a scheduled-status filter;
 * manual scheduling does not expose a reusable time-slot Queue workflow.
 *
 * The expand/collapse chevron is a sibling `MotionButton`, not a control nested
 * inside the route button: it overlays the row's right edge, is named
 * "Toggle {label} sub-navigation", and exposes `aria-expanded`/`aria-controls`
 * for the accordion below. Native button semantics give Enter/Space activation
 * with default-prevented scroll, so no manual keydown handling is needed.
 */
function SidebarNavItemRow({
  item,
  currentView,
  collapsed,
  hoveredNavId,
  postsExpanded,
  onHover,
  onTogglePosts,
  onNavigate,
}: SidebarNavItemRowProps) {
  const Icon = item.icon;
  const { lowMotion } = useMotionPreference();
  const { t } = useI18n();
  const isPostItem = item.id === "posts";
  const isActive = currentView === item.id;
  const hasSubItems = Boolean(item.subItems && item.subItems.length > 0);
  const [hoveredSubId, setHoveredSubId] = useState<string | null>(null);
  const subItemsId = useId();

  const handleClick = () => {
    if (isPostItem && hasSubItems && !collapsed) {
      onNavigate(item.id);
      if (!postsExpanded) onTogglePosts();
    } else {
      onNavigate(item.id);
    }
  };

  return (
    <div className="relative flex flex-col">
      <Button
        data-nav-row
        type="button"
        onClick={handleClick}
        onMouseEnter={() => {
          onHover(item.id);
          preloadDashboardRoute(item.id);
        }}
        onFocus={() => preloadDashboardRoute(item.id)}
        onPointerDown={() => preloadDashboardRoute(item.id)}
        onMouseLeave={() => onHover(null)}
        className={cn(
          "relative z-10 w-full justify-start gap-0 rounded-[7px] px-1.5 py-0 text-left",
          "h-8",
          isActive && (!hasSubItems || collapsed)
            ? "bg-hover-2 font-semibold text-ink hover:bg-hover-2 hover:text-ink group-hover/glide:bg-transparent"
            : isActive
              ? "text-ink font-semibold hover:bg-transparent hover:text-ink"
              : "text-ink-2 hover:bg-transparent hover:text-ink font-medium",
        )}
        variant="ghost"
        size="sm"
        title={collapsed ? item.label : undefined}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center",
            isActive ? "text-ink" : "text-ink-2",
          )}
        >
          <Icon className="size-4" isHovered={hoveredNavId === item.id} />
        </span>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={lowMotion ? false : { opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
              transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                "ml-1.5 flex flex-1 items-center justify-between overflow-hidden",
                hasSubItems && "pr-7",
              )}
            >
              <span className="truncate text-[13.5px] tracking-tight">{item.label}</span>
              {!hasSubItems && item.badge ? (
                <span className="ml-auto rounded-full bg-accent-tint px-1.5 py-0.5 text-[10px] font-bold text-accent-ink uppercase leading-none">
                  {item.badge}
                </span>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </Button>

      {/* Sibling expand/collapse control: overlays the row's right edge so it is
          never nested inside the route button. `aria-expanded`/`aria-controls`
          name the relationship for assistive tech; the motion wrapper preserves
          the label-reveal mount/unmount timing while the chevron rotates on
          `postsExpanded`. Space activation never scrolls because Button
          prevents default. */}
      <AnimatePresence initial={false}>
        {!collapsed && hasSubItems && (
          <MotionButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("Toggle {label} sub-navigation", { label: item.label })}
            aria-expanded={postsExpanded}
            aria-controls={subItemsId}
            onClick={onTogglePosts}
            initial={lowMotion ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
            transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-1 top-1 z-20 size-5.5 cursor-pointer p-0 text-ink-3 hover:bg-transparent hover:text-ink"
          >
            <AnimatedChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                postsExpanded ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden="true"
            />
          </MotionButton>
        )}
      </AnimatePresence>

      {/* Render Expandable Sub-items with smooth sliding collapse/expand */}
      <AnimatePresence initial={false}>
        {!collapsed && hasSubItems && postsExpanded && (
          <motion.div
            key="sub-items-container"
            id={subItemsId}
            initial={lowMotion ? false : { height: 0, opacity: 0 }}
            animate={{
              height: "auto",
              opacity: 1,
              transition: lowMotion
                ? { duration: 0 }
                : {
                    height: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
                    opacity: { duration: 0.16, delay: 0.05 },
                  },
            }}
            exit={{
              height: 0,
              opacity: 0,
              transition: lowMotion
                ? { duration: 0 }
                : {
                    height: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
                    opacity: { duration: 0.1 },
                  },
            }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5 pl-2.5 pt-0.5 pb-0.5">
              {item.subItems?.map((sub) => {
                const SubIcon = sub.icon;
                const isSubActive = currentView === sub.view;
                return (
                  <Button
                    key={sub.id}
                    data-nav-row
                    type="button"
                    variant="ghost"
                    size="sm"
                    onMouseEnter={() => setHoveredSubId(sub.id)}
                    onMouseLeave={() => setHoveredSubId(null)}
                    onClick={() => onNavigate(sub.view)}
                    className={cn(
                      "relative z-10 w-full justify-start gap-0 h-7 rounded-[6px] pl-6 pr-2 text-left text-[12.5px]",
                      isSubActive
                        ? "bg-hover-2 font-semibold text-ink shadow-xs hover:bg-hover-2 hover:text-ink"
                        : "text-ink-2 hover:bg-hover hover:text-ink font-medium",
                    )}
                  >
                    <SubIcon
                      className="size-3.5 mr-2 shrink-0 text-ink-3"
                      isHovered={hoveredSubId === sub.id}
                    />
                    <span className="truncate">{sub.label}</span>
                  </Button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
/**
 * Renders the primary collapsible application navigation sidebar.
 *
 * Features:
 * - Collapsible state (expanded 240px vs collapsed 56px icon-only rail).
 * - Gliding physics hover highlight overlay via `SidebarGlideHighlight`.
 * - Shared Meltiply mark beside noninteractive active Workspace identity; switching is not an available workflow.
 * - Interactive quick search / jump filter across navigation destinations.
 * - Theme toggle (dark/light mode updates the document root immediately and persists through the shared preference only after functional consent).
 * - Low-motion toggle (manual preference persists only after functional consent; OS reduced-motion is always respected, and the control remains inert while collapsed so its exit animation cannot leave a clickable or tabbable ghost).
 * - Consent remains owned by the first-visit prompt; no sidebar control reopens a saved decision.
 * - User profile info with account-provided avatar, user-icon fallback, and sign-out trigger.
 * - Instant font-weight bolding on active nav items using `transition-colors` without interpolation lag.
 *
 * @param props - Navigation state (`currentView`), navigation callback, and optional styling.
 * @returns Rendered sidebar `<aside>` element.
 */
export function SidebarNav({
  currentView,
  onNavigate,
  onSelectRecent: _onSelectRecent,
  className = "",
}: SidebarNavProps) {
  const { user, workspaceName, logout } = useWorkspace();
  const { requestedTheme, toggleTheme } = useTheme();
  const { t } = useI18n();
  const { lowMotion, manualLowMotion, setManualLowMotion, systemLowMotion } = useMotionPreference();
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const isDark = requestedTheme === "dark";
  const [hoveredNavId, setHoveredNavId] = useState<WorkspaceView | null>(null);
  const [postsExpanded, setPostsExpanded] = useState(true);

  const [collapseHovered, setCollapseHovered] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Theme switching flows through Meltiply's ThemeProvider so the `dark` class
  // and consent-gated shared preference stay in sync.
  /**
   * Requests the palette opposite the latest request and reports where the
   * click happened so the provider's wave can start there. `toggleTheme`
   * derives the target from the newest requested selection, so rapid repeated
   * clicks retarget or reverse one running wave instead of restarting it.
   * Pointer activation passes the click point; keyboard activation has no
   * usable coordinates, so `themeOriginFromEvent` falls back to the toggle
   * button's center.
   */
  const handleToggleTheme = (event: React.MouseEvent<HTMLButtonElement>) => {
    toggleTheme(themeOriginFromEvent(event));
  };

  const handleOpenSearch = () => {
    if (collapsed) {
      setCollapsed(false);
    }
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const filteredNavItems = searchQuery
    ? WORKSPACE_NAV_ITEMS.filter((item) =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : WORKSPACE_NAV_ITEMS;

  const activeWorkspaceName = workspaceName ?? "Meltiply Workspace";
  const workspaceSubtitle = user?.role === "admin" ? t("Workspace Admin") : t("Workspace");

  return (
    <aside
      className={cn(
        "relative flex flex-col h-full border-r border-line bg-surface select-none transition-[width] duration-300",
        collapsed ? "w-[56px]" : "w-[240px]",
        className,
      )}
      style={{ transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}
    >
      {/* Active Workspace identity */}
      <div className="relative p-2 pb-2">
        <div className="relative">
          <div
            className="flex w-full items-center rounded-control p-1.5 text-left"
            title={activeWorkspaceName}
            aria-label={activeWorkspaceName}
          >
            <BrandMark className="size-7 shrink-0 text-ink" />
            <AnimatePresence initial={false}>
              {!collapsed && (
                <motion.div
                  initial={lowMotion ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
                  transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
                  className="ml-2 flex min-w-0 flex-1 items-center justify-between overflow-hidden"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-bold tracking-tight text-ink leading-none">
                      {activeWorkspaceName}
                    </span>
                    <span className="truncate text-[10.5px] font-medium text-ink-3 mt-1 leading-none">
                      {workspaceSubtitle}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Quick Search */}
      <QuickSearch
        collapsed={collapsed}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        onOpenSearch={handleOpenSearch}
        onCloseSearch={() => {
          setSearchQuery("");
          setSearchOpen(false);
        }}
        onChangeQuery={setSearchQuery}
      />

      {/* Navigation List */}
      <nav ref={navRef} className="relative flex-1 overflow-y-auto px-2 py-2 hide-scrollbar">
        <SidebarGlideHighlight containerRef={navRef} itemSelector="[data-nav-row]" />
        <div className="flex flex-col gap-0.5">
          {filteredNavItems.map((item) => (
            <SidebarNavItemRow
              key={item.id}
              item={item}
              currentView={currentView}
              collapsed={collapsed}
              hoveredNavId={hoveredNavId}
              postsExpanded={postsExpanded}
              onHover={setHoveredNavId}
              onTogglePosts={() => setPostsExpanded((p) => !p)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>

      {/* Footer Controls: Theme, Low motion, Collapse, User */}
      <div className="border-t border-line p-2 flex flex-col gap-1">
        <div
          className="relative w-full transition-[height] duration-300"
          style={{
            height: collapsed ? "60px" : "28px",
            transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleToggleTheme}
            className="absolute left-1.5 top-0 size-7 rounded-control p-0 text-ink-3 hover:bg-hover hover:text-ink shrink-0"
            title={isDark ? "Switch to Light mode" : "Switch to Dark mode"}
          >
            {/* The shared atom is root/CSS-driven: `.dark`/`data-theme` selects
             * the glyph, so it needs no React state or hover plumbing. */}
            <ThemeIcon className="size-3.5" />
          </Button>
          {/*
            The Low motion control stays mounted while collapsed so its exit
            animation can play under normal motion, but `inert`, `aria-hidden`,
            and `tabIndex={-1}` remove it from pointer, keyboard, and
            screen-reader interaction the moment collapse begins — no clickable
            or tabbable ghost lingers during the fade. `animate` (not `exit`)
            drives the visual shrink so interaction state and animation are
            independent; `initial={false}` mounts it at rest on first render.
          */}
          <MotionButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("Low motion")}
            aria-pressed={manualLowMotion}
            aria-description={
              systemLowMotion ? t("Your device is requesting reduced motion") : undefined
            }
            aria-hidden={collapsed}
            inert={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => setManualLowMotion(!manualLowMotion)}
            initial={false}
            animate={
              collapsed
                ? lowMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.7 }
                : { opacity: 1, scale: 1 }
            }
            transition={{ duration: lowMotion ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute left-9 top-0 size-7 rounded-control p-0 shrink-0",
              manualLowMotion
                ? "bg-accent-tint text-accent-ink hover:bg-accent-tint hover:text-accent-ink"
                : "text-ink-3 hover:bg-hover hover:text-ink",
            )}
            title={
              systemLowMotion
                ? t("Low motion — your device is requesting reduced motion")
                : manualLowMotion
                  ? t("Low motion on")
                  : t("Low motion")
            }
          >
            {/* CSS on `data-low-motion` picks the play/pause glyph, matching
             * the effective (manual OR OS) motion state. */}
            <MotionIcon className="size-3.5" />
          </MotionButton>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            onMouseEnter={() => setCollapseHovered(true)}
            onMouseLeave={() => setCollapseHovered(false)}
            className="absolute right-1.5 size-7 rounded-control p-0 text-ink-3 hover:bg-hover hover:text-ink shrink-0"
            style={{
              top: collapsed ? "32px" : "0px",
              transition:
                "top 300ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease",
            }}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <AnimatedCollapseToggle
              collapsed={collapsed}
              isHovered={collapseHovered}
              className="size-3.5"
            />
          </Button>
        </div>

        {/* User profile row */}
        <div className="flex items-center rounded-control p-1.5 text-left transition-colors hover:bg-hover/70 min-h-[36px] overflow-hidden">
          <Avatar className="size-7 border border-line shrink-0">
            <AvatarImage src={user?.avatarUrl ?? undefined} alt={user?.name ?? user?.email ?? ""} />
            <AvatarFallback className="bg-muted text-ink">
              <UserRound className="size-4" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>

          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                initial={lowMotion ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={lowMotion ? { opacity: 0 } : { opacity: 0, x: -6 }}
                transition={{ duration: lowMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="ml-2.5 flex flex-1 min-w-0 flex-col justify-center leading-tight overflow-hidden"
              >
                <span className="text-[12.5px] font-semibold text-ink truncate">
                  {user?.name || "Creator"}
                </span>
                <span className="text-[10px] text-ink-3 truncate font-mono">
                  {user?.email || ""}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {!collapsed && (
              <MotionButton
                initial={lowMotion ? false : { opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={lowMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                transition={{ duration: lowMotion ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => {
                  logout().catch(() => {});
                }}
                className="size-6 rounded p-0 text-ink-3 hover:bg-red-tint hover:text-red transition-colors shrink-0 ml-1"
                title="Sign out"
              >
                <AnimatedLogOut className="size-3.5" />
              </MotionButton>
            )}
          </AnimatePresence>
        </div>
      </div>
    </aside>
  );
}
