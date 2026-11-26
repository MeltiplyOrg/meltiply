import * as React from "react";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";
import { brandProfileColorClass, BRAND_PROFILE_COLORS, type BrandProfileColor } from "@/types";
import {
  paletteColumnStep,
  resolvePaletteLayout,
  type PaletteLayout,
} from "./brand-profile-palette-layout";

const HONEYCOMB_ROW_COUNTS = [9, 8, 9, 8, 9, 8] as const;

const HONEYCOMB_ROWS: readonly BrandProfileColor[][] = (() => {
  const rows: BrandProfileColor[][] = [];
  let offset = 0;
  for (const count of HONEYCOMB_ROW_COUNTS) {
    rows.push(BRAND_PROFILE_COLORS.slice(offset, offset + count));
    offset += count;
  }
  return rows;
})();

const HEXAGON_POINTS = "14,1.5 26.5,8.75 26.5,23.25 14,30.5 1.5,23.25 1.5,8.75";

export function BrandProfileColorPicker({
  value,
  onChange,
  label,
}: {
  value: BrandProfileColor;
  onChange: (color: BrandProfileColor) => void;
  label: string;
}) {
  const swatchRefs = React.useRef(new Map<BrandProfileColor, HTMLButtonElement>());
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = React.useState<PaletteLayout>("grid-1");
  const columnStep = paletteColumnStep(layout);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const dialog = root.closest<HTMLElement>('[role="dialog"]');
    const measure = () => {
      const rootStyles = getComputedStyle(root);
      const horizontalPadding =
        (parseFloat(rootStyles.paddingLeft) || 0) + (parseFloat(rootStyles.paddingRight) || 0);
      const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const dialogContentWidth = dialog
        ? dialog.clientWidth -
          (parseFloat(getComputedStyle(dialog).paddingLeft) || 0) -
          (parseFloat(getComputedStyle(dialog).paddingRight) || 0)
        : Number.POSITIVE_INFINITY;
      root.style.maxWidth = Number.isFinite(dialogContentWidth)
        ? `${Math.max(0, dialogContentWidth)}px`
        : "";
      const availableWidth = Math.min(root.clientWidth, dialogContentWidth) - horizontalPadding;
      setLayout(resolvePaletteLayout(availableWidth, rootFontSize));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (dialog) observer.observe(dialog);
    return () => observer.disconnect();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const currentIndex = BRAND_PROFILE_COLORS.indexOf(value);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % BRAND_PROFILE_COLORS.length;
      event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + BRAND_PROFILE_COLORS.length) % BRAND_PROFILE_COLORS.length;
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      nextIndex = Math.min(BRAND_PROFILE_COLORS.length - 1, currentIndex + columnStep);
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      nextIndex = Math.max(0, currentIndex - columnStep);
      event.preventDefault();
    } else if (event.key === "Home") {
      nextIndex = 0;
      event.preventDefault();
    } else if (event.key === "End") {
      nextIndex = BRAND_PROFILE_COLORS.length - 1;
      event.preventDefault();
    }

    if (nextIndex !== currentIndex) {
      const nextColor = BRAND_PROFILE_COLORS[nextIndex]!;
      onChange(nextColor);
      swatchRefs.current.get(nextColor)?.focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className="flex w-full min-w-0 flex-col items-center gap-2.5 overflow-hidden rounded-control border border-line bg-surface/60 p-3 @container"
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      <div data-brand-color-palette data-layout={layout}>
        {HONEYCOMB_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} data-hex-row>
            {row.map((color) => {
              const isSelected = value === color;
              return (
                <Button
                  key={color}
                  ref={(node: HTMLButtonElement | null) => {
                    if (node) {
                      swatchRefs.current.set(color, node);
                    } else {
                      swatchRefs.current.delete(color);
                    }
                  }}
                  type="button"
                  variant="ghost"
                  role="radio"
                  aria-checked={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  title={color}
                  onClick={() => onChange(color)}
                  className={cn(
                    "group relative flex w-[var(--hex-w)] h-[var(--hex-h)] min-w-0 min-h-0 pointer-coarse:min-h-0 items-center justify-center p-0 cursor-pointer bg-transparent hover:bg-transparent transition-transform duration-150 focus:outline-none focus-visible:scale-110 focus-visible:ring-0 focus-visible:z-20 shrink-0 [&_svg]:size-full",
                    isSelected ? "z-10 scale-105" : "hover:scale-110 hover:z-10",
                  )}
                >
                  <svg
                    viewBox="0 0 28 32"
                    className={cn(
                      "size-full overflow-visible transition-shadow duration-150",
                      isSelected && "drop-shadow-md",
                    )}
                    aria-hidden="true"
                  >
                    <polygon
                      points={HEXAGON_POINTS}
                      fill={color}
                      stroke="var(--color-surface)"
                      strokeWidth={isSelected ? "2.25" : "1.5"}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {isSelected ? (
                      <path
                        d="M9.5 16l3 3 6-6"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                        className="text-primary-foreground drop-shadow-sm"
                      />
                    ) : null}
                  </svg>
                </Button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex w-full flex-wrap items-center justify-between gap-y-1 border-t border-line/60 px-1.5 pt-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-3.5 rounded-full border border-line shadow-hairline shrink-0",
              brandProfileColorClass(value),
            )}
            aria-hidden="true"
          />
          <span className="font-mono text-[11px] font-semibold text-ink uppercase tracking-wider">
            {value.toUpperCase()}
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-ink-3">
          {BRAND_PROFILE_COLORS.indexOf(value) + 1} / {BRAND_PROFILE_COLORS.length}
        </span>
      </div>
    </div>
  );
}
