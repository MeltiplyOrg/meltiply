import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactElement } from "react";
import { SidebarItem } from "fumadocs-ui/components/sidebar/base";
import type { Separator as PageTreeSeparator, Item as PageTreeItem } from "fumadocs-core/page-tree";
import { SidebarGlideHighlight } from "@meltiply/ui/sidebar-glide-highlight";

/**
 * Route context shared by the stable sidebar renderers. The persisted docs
 * shell updates this value when Astro swaps pages, so `NavItem` re-reads the
 * route and `DocsNavGlide` retargets without remounting rows or depending on
 * a second peer-resolved Fumadocs framework context.
 */
export const DocsPathnameContext = createContext("/");

/** Selector for the navigation rows the pill tracks (page-tree links only). */
const NAV_ITEM_SELECTOR = "a.docs-nav-item";
/** Selector for the Radix ScrollArea viewport both sidebar modes share. */
const VIEWPORT_SELECTOR = "[data-radix-scroll-area-viewport]";

/**
 * Turns page-tree separators into accessible section headings, visually
 * distinct from the links they group through `docs-nav-section`; the tight
 * `mt-3` rhythm matches the app's dense nav and parent CSS strips the first
 * heading's margin entirely. Fumadocs shares this renderer between the
 * desktop sidebar and mobile drawer, and the headings sit outside the
 * article's outline.
 */
export function NavSection({ item }: { item: PageTreeSeparator }) {
  return <h2 className="docs-nav-section mt-3 mb-1 px-2">{item.name}</h2>;
}

/**
 * Renders a public guide as a text-only app-style row with no icon slot.
 * The label names the link; `active` mirrors route context onto Fumadocs'
 * `data-active`. Selection keeps its static background independently of the
 * hover-only glide. Fumadocs owns drawer dismissal and active-item scrolling;
 * the local route context keeps this renderer's
 * identity stable as the persisted shell receives new Astro page props.
 */
export function NavItem({ item }: { item: PageTreeItem }) {
  const pathname = useContext(DocsPathnameContext);
  const active = pathname === item.url || pathname === `${item.url}/`;
  return (
    <SidebarItem
      href={item.url}
      external={item.external}
      active={active}
      aria-current={active ? "page" : undefined}
      className="docs-nav-item"
    >
      {item.name}
    </SidebarItem>
  );
}

/**
 * Docs adapter for the shared `SidebarGlideHighlight` — the same spring
 * implementation the app sidebar uses, pointed at the page-tree rows.
 *
 * Rendered once per sidebar instance through the `banner` slot. A display:
 * contents probe resolves the enclosing `aside` on desktop or in the drawer,
 * which becomes the shared pill's non-scrolling positioning root, while
 * `viewportSelector` points it at the nested Radix ScrollArea so the travelling
 * indicator stays clipped to the nav column. Like the app, only pointer hover
 * drives the pill: entry fades in at the row and exit fades out in place.
 * Fumadocs mounts only the matching mode, giving each surface an
 * independent pill that rebinds on breakpoint remounts and document swaps.
 */
export function DocsNavGlide(): ReactElement {
  const asideRef = useRef<HTMLElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);

  /**
   * Captures the enclosing sidebar aside through a probe element. The probe
   * stays mounted beside the pill so its callback doesn't re-fire, and the
   * state mirror gates the pill until the root exists — the shared
   * component's bind effect reads the same ref once it does.
   */
  const probeRef = useCallback((el: HTMLElement | null) => {
    const next = el?.closest("aside") ?? null;
    asideRef.current = next;
    setAside((prev) => (prev === next ? prev : next));
  }, []);

  return (
    <>
      <span ref={probeRef} aria-hidden style={{ display: "contents" }} />
      {aside ? (
        <SidebarGlideHighlight
          containerRef={asideRef}
          itemSelector={NAV_ITEM_SELECTOR}
          viewportSelector={VIEWPORT_SELECTOR}
          className="docs-nav-glide"
        />
      ) : null}
    </>
  );
}
