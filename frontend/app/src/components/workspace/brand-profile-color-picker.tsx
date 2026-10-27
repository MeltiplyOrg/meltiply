import * as React from "react";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";
import { brandProfileColorClass, BRAND_PROFILE_COLORS, type BrandProfileColor } from "@/types";
import {
  paletteColumnStep,
  resolvePaletteLayout,
  type PaletteLayout,
} from "./brand-profile-palette-layout";

/** Row segment counts creating the alternating 9 / 8 honeycomb beehive grid across 51 palette colors. */
const HONEYCOMB_ROW_COUNTS = [9, 8, 9, 8, 9, 8] as const;

/**
 * Pre-sliced honeycomb rows mapping all 51 contract palette colors into an interlocking beehive lattice.
 * Alternating between 9 and 8 items per row shifts every 8-item row by half a column pitch when centered.
 */
const HONEYCOMB_ROWS: readonly BrandProfileColor[][] = (() => {
  const rows: BrandProfileColor[][] = [];
  let offset = 0;
  for (const count of HONEYCOMB_ROW_COUNTS) {
    rows.push(BRAND_PROFILE_COLORS.slice(offset, offset + count));
    offset += count;
  }
  return rows;
})();

/**
 * Soft-rounded pointy-topped hexagon SVG polygon vertex string for a 28x32 viewBox.
 * Each swatch's SVG scales with its cell, so strokes and the selection check stay
 * proportional in both the honeycomb and the flat column grids.
 */
const HEXAGON_POINTS = "14,1.5 26.5,8.75 26.5,23.25 14,30.5 1.5,23.25 1.5,8.75";

/**
 * Contract-palette color picker designed as an organic, interlocking beehive of hexagonal swatches.
 *
 * Provides an eye-friendly, tactile color-selection matrix for Brand Profile ownership labels.
 * All 51 OpenAPI contract colors render once and reflow by the dialog's available content width:
 * wide dialogs keep the 6-row [9, 8, 9, 8, 9, 8] honeycomb with its proportional row overlap,
 * while narrower dialogs switch to progressively fewer flat columns (six down to one) so each
 * swatch keeps a usable touch target instead of shrinking the lattice. At 320px the palette uses
 * four 42x48px columns. Vertical overflow scrolls inside the dialog; the palette never widens the
 * name or description fields.
 * Interactive feedback on hover relies exclusively on a smooth cell size-up (scale-110) without
 * any rectangular button background showing behind the pointy-topped hexagonal tile.
 * Implements WAI-ARIA RadioGroup with roving tabindex: arrow, Home, and End keys move both
 * selection and DOM focus to the newly checked swatch so focus never strands on the old one.
 * Up/Down step by the active column count; Left/Right stay in flat palette order.
 * @param props.value - Currently active contract palette hex color (e.g. '#b91c1c').
 * @param props.onChange - Callback fired with the chosen BrandProfileColor upon swatch activation.
 * @param props.label - Accessible name applied to the root radiogroup element.
 * @returns React element rendering the comfortable beehive color picker and selected swatch readout.
 *
 * @example
 * ```tsx
 * <BrandProfileColorPicker
 *   value="#b91c1c"
 *   onChange={(color) => setDraftColor(color)}
 *   label="Choose a profile color"
 * />
 * ```
 */
export function BrandProfileColorPicker({
  value,
  onChange,
  label,
}: {
  value: BrandProfileColor;
  onChange: (color: BrandProfileColor) => void;
  label: string;
}) {
  /**
   * Swatch elements keyed by palette color, letting keyboard navigation move DOM focus to the
   * newly selected radio. Roving `tabIndex` alone only governs Tab order; WAI-ARIA radio groups
   * additionally require focus to follow selection, so the keydown path focuses the target
   * swatch explicitly after `onChange` fires.
   */
  const swatchRefs = React.useRef(new Map<BrandProfileColor, HTMLButtonElement>());
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = React.useState<PaletteLayout>("grid-1");
  const columnStep = paletteColumnStep(layout);

  // Measure before paint so the first frame already uses the arrangement that
  // fits; observing both the root and its dialog reflows the palette when either
  // changes. The padding is read from the rendered element because `p-3` is
  // rem-based, and the root font size is passed so the rem thresholds scale
  // with the CSS. The dialog's content width is the cap: a narrow dialog can be
  // narrower than the picker's intrinsic width, and choosing columns from the
  // expanded picker would clip the palette at high zoom. The dialog itself must
  // be observed because that cap otherwise prevents the picker from growing
  // when the dialog expands.
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
      // A narrow dialog can be narrower than the picker's intrinsic grid. Cap
      // the rendered picker to the dialog's content box before choosing columns
      // so a high-zoom palette stays inside the surface instead of inheriting
      // the expanded dialog grid width.
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

  /**
   * Handles radiogroup keyboard navigation: Left/Right step through the flat palette,
   * Up/Down step by the active column count, and Home/End jump to the ends. Each
   * handled key selects the target color via `onChange` and moves DOM focus to its
   * swatch, keeping focus on the checked radio as the roving tabindex re-renders.
   * Unhandled keys pass through untouched.
   */
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
      // Focus the newly selected swatch: the keyed map keeps the same DOM node across the
      // controlled re-render, so focus lands on the checked radio even before tabIndex flips.
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
      {/* `globals.css` owns this lattice's responsive geometry: `data-layout`
          selects the 9/8 honeycomb or the flat six/five-column grids, and the
          container-query variables derive every cell from the picker width. */}
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
                    // `p-0` and `[&_svg]:size-full` cancel the Button defaults (`px-4 py-2`,
                    // `[&_svg]:size-4`) so the hexagon SVG fills the full fluid lattice cell.
                    // `pointer-coarse:min-h-0` replaces the shared Button's
                    // `pointer-coarse:min-h-11` floor, which would otherwise force each
                    // swatch to 44px on touch and break the honeycomb.
                    // `bg-transparent hover:bg-transparent` removes the rectangular button
                    // hover background so only the cell size-up (scale-110) provides feedback.
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
