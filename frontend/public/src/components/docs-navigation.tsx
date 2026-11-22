import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactElement } from "react";
import { SidebarItem } from "fumadocs-ui/components/sidebar/base";
import type { Separator as PageTreeSeparator, Item as PageTreeItem } from "fumadocs-core/page-tree";
import { SidebarGlideHighlight } from "@meltiply/ui/sidebar-glide-highlight";

export const DocsPathnameContext = createContext("/");

const NAV_ITEM_SELECTOR = "a.docs-nav-item";
const VIEWPORT_SELECTOR = "[data-radix-scroll-area-viewport]";

export function NavSection({ item }: { item: PageTreeSeparator }) {
  return <h2 className="docs-nav-section mt-3 mb-1 px-2">{item.name}</h2>;
}

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

export function DocsNavGlide(): ReactElement {
  const asideRef = useRef<HTMLElement | null>(null);
  const [aside, setAside] = useState<HTMLElement | null>(null);

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
