import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOCItem, useActiveAnchor, useItems, type TOCItemType } from "fumadocs-core/toc";
import { TOCScrollArea, useTOCItems } from "fumadocs-ui/components/toc";
import {
  TOCProvider,
  type TOCPopoverProps,
  type TOCProps,
} from "fumadocs-ui/layouts/docs/page/slots/toc";
import { DocsTocPlane } from "./docs-toc-plane";
import { initializeReadingRail } from "./docs-reading-rail";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "fumadocs-ui/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Original reading-progress rail: native document scrolling moves a decorative
 * plane continuously between headings, while Fumadocs owns anchor semantics and
 * active-link tracking. Cached row geometry stays rail-relative even while
 * row transforms change the links' offset parents during route animation;
 * reduced motion retains progress without rotation. During outgoing navigation
 * the return-flight owns the plane; tracking resumes when route state clears.
 * Desktop and mobile share heading hierarchy, decoration and anchor states;
 * `labelledBy` uniquely names each nav and scopes prehydration DOM adoption.
 * The desktop bootstrap paints before hydration; each mobile opening measures
 * independently. `onNavigate` lets mobile dismiss after a heading selection.
 */
function ReadingRail({
  items,
  labelledBy,
  onNavigate,
}: {
  items: TOCItemType[];
  labelledBy: string;
  onNavigate?: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);

  const activeAnchor = useActiveAnchor();
  const minDepth = Math.min(...items.map((item) => item.depth));
  const [initial] = useState(() => {
    const root =
      typeof document === "undefined" ? null : document.getElementById(`${labelledBy}-rail`);
    if (!root) return null;
    const progress = root.querySelector<SVGPathElement>(".docs-reading-progress");
    // CSSOM rounds SVG lengths; preserve the bootstrap's exact style strings.
    const progressStyles = Object.fromEntries<string | undefined>(
      (progress?.getAttribute("style") ?? "").split(";").map((declaration) => {
        const [property, value] = declaration.split(":");
        return [property, value] as const;
      }),
    );
    const planeStyles = Object.fromEntries<string | undefined>(
      (root.querySelector(".docs-reading-plane")?.getAttribute("style") ?? "")
        .split(";")
        .map((declaration) => {
          const [property, value] = declaration.split(":");
          return [property, value] as const;
        }),
    );
    return {
      measured: root.dataset.measured,
      path: root.querySelector(".docs-reading-remaining")?.getAttribute("d") ?? undefined,
      dasharray: progressStyles["stroke-dasharray"],
      dashoffset: progressStyles["stroke-dashoffset"],
      transform: planeStyles.transform,
      passed: Object.fromEntries(
        Array.from(root.querySelectorAll<HTMLAnchorElement>("a"), (link) => [
          link.hash,
          link.dataset.passed,
        ]),
      ),
    };
  });

  useClientLayoutEffect(() => {
    const root = rootRef.current;
    if (root) return initializeReadingRail(root);
  }, [items, minDepth]);

  return (
    <nav
      ref={rootRef}
      id={`${labelledBy}-rail`}
      className="docs-reading-rail"
      aria-labelledby={labelledBy}
      data-measured={initial?.measured}
    >
      <svg className="docs-reading-track" aria-hidden="true">
        <path className="docs-reading-remaining" d={initial?.path} />
        <path
          className="docs-reading-progress"
          d={initial?.path}
          style={
            initial
              ? {
                  strokeDasharray: initial.dasharray,
                  strokeDashoffset: initial.dashoffset,
                }
              : undefined
          }
        />
      </svg>
      <span
        className="docs-reading-plane"
        aria-hidden="true"
        style={initial ? { transform: initial.transform } : undefined}
      >
        <DocsTocPlane />
      </span>
      <ol className="docs-reading-items">
        {items.map((item) => (
          <li key={item.url} data-depth={item.depth}>
            <TOCItem
              href={item.url}
              data-passed={initial?.passed[item.url]}
              aria-current={item.url === `#${activeAnchor}` ? "location" : undefined}
              className="docs-reading-link"
              onClick={onNavigate}
              style={{
                paddingInlineStart: 28 + Math.max(0, item.depth - minDepth) * 12,
              }}
            >
              {item.title}
            </TOCItem>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Uses the shared reading rail in Fumadocs' desktop sticky column, preserving
 * its empty-page footprint. A stationary clipping frame surrounds the native
 * scroll area so route animation retracts rows without moving article layout.
 */
function DocsRailToc({ container, header, footer }: TOCProps) {
  const items = useTOCItems();
  if (items.length === 0 && !header && !footer) {
    return <div id="nd-toc-placeholder" className="hidden xl:layout:[--fd-toc-width:268px]" />;
  }
  return (
    <div
      {...container}
      id="nd-toc"
      className={[
        "sticky top-(--fd-docs-row-1) h-[calc(var(--fd-docs-height)-var(--fd-docs-row-1))] flex flex-col [grid-area:toc] w-(--fd-toc-width) pt-12 pe-4 pb-2 xl:layout:[--fd-toc-width:268px] max-xl:hidden",
        container?.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {header}
      <h3 id="toc-title">On this page</h3>
      <div className="docs-toc-viewport">
        <TOCScrollArea data-docs-toc-list="">
          {items.length > 0 && <ReadingRail items={items} labelledBy="toc-title" />}
        </TOCScrollArea>
      </div>
      {footer}
    </div>
  );
}

/**
 * Adapts the same rail to a touch-sized disclosure rather than a second TOC
 * design. Selecting a heading or clicking outside closes it; Escape closes and
 * restores trigger focus. Radix owns disclosure semantics and mount lifecycle,
 * so each opening measures current scroll progress, including nested headings.
 * The collapsed trigger retains Fumadocs' heading-based progress circle: the
 * furthest visible heading counts toward completion, with zero before any
 * heading is active. Tracking stays subscribed while the list is unmounted.
 * Pages without headings or supplemental content omit the mobile strip.
 */
function DocsRailPopover({ container, trigger, content, header, footer }: TOCPopoverProps) {
  const items = useTOCItems();
  const activeAnchor = useActiveAnchor();
  const observedItems = useItems();
  const progress =
    ((observedItems.findLastIndex((item) => item.active) + 1) / Math.max(1, observedItems.length)) *
    100;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = items.find((item) => item.url === `#${activeAnchor}`);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  if (items.length === 0 && !header && !footer) return null;
  return (
    <Collapsible
      {...container}
      ref={rootRef}
      open={open}
      onOpenChange={setOpen}
      data-toc-popover=""
      className={[
        "docs-rail-popover sticky top-(--fd-docs-row-2) z-10 [grid-area:toc-popover] h-(--fd-toc-popover-height) xl:hidden max-xl:layout:[--fd-toc-popover-height:44px]",
        container?.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header>
        <CollapsibleTrigger
          {...trigger}
          ref={triggerRef}
          data-toc-popover-trigger=""
          className={["docs-rail-trigger", trigger?.className].filter(Boolean).join(" ")}
        >
          {open ? (
            <DocsTocPlane />
          ) : (
            <svg
              className="docs-rail-progress"
              viewBox="0 0 18 18"
              role="progressbar"
              aria-label="Reading progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle className="docs-rail-progress-track" cx="9" cy="9" r="7" />
              <circle
                cx="9"
                cy="9"
                r="7"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - progress}
                strokeLinecap="round"
                transform="rotate(-90 9 9)"
              />
            </svg>
          )}
          <span id="mobile-toc-title">On this page</span>
          {!open && selected && <span className="docs-rail-current">{selected.title}</span>}
          <ChevronDown aria-hidden="true" className="docs-rail-chevron" />
        </CollapsibleTrigger>
        <CollapsibleContent
          {...content}
          data-toc-popover-content=""
          className={["docs-rail-content", content?.className].filter(Boolean).join(" ")}
        >
          {header}
          <TOCScrollArea>
            {items.length > 0 && (
              <ReadingRail
                items={items}
                labelledBy="mobile-toc-title"
                onNavigate={() => setOpen(false)}
              />
            )}
          </TOCScrollArea>
          {footer}
        </CollapsibleContent>
      </header>
    </Collapsible>
  );
}

export const docsRailTocSlots = {
  provider: TOCProvider,
  main: DocsRailToc,
  popover: DocsRailPopover,
};
