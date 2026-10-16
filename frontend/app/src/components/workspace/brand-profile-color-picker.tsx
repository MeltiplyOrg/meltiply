import * as React from "react";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";
import { brandProfileColorClass, BRAND_PROFILE_COLORS, type BrandProfileColor } from "@/types";

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
 * Cells render it at 42x48 (1.5x), so strokes and the selection check scale uniformly.
 */
const HEXAGON_POINTS = "14,1.5 26.5,8.75 26.5,23.25 14,30.5 1.5,23.25 1.5,8.75";

/**
 * Fixed-palette color picker designed as an organic, interlocking beehive of hexagonal swatches.
 *
 * Provides an eye-friendly, tactile color-selection matrix for Brand Profile ownership labels.
 * Tessellates the 51 OpenAPI contract colors into 6 centered, alternating rows [9, 8, 9, 8, 9, 8]
 * with rounded vertices and soft surface tile borders to prevent chromatic visual fatigue.
 * Cells are 42x48px with 6px column gaps and a -9px row overlap: the widest 9-cell row spans
 * 426px, fitting the Brand Profile dialog's ~438px content lane without clipping or overflow.
 * Interactive feedback on hover relies exclusively on a smooth cell size-up (scale-110) without
 * any rectangular button background showing behind the pointy-topped hexagonal tile.
 * Implements WAI-ARIA RadioGroup with roving tabindex: arrow, Home, and End keys move both
 * selection and DOM focus to the newly checked swatch so focus never strands on the old one.
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

  /**
   * Handles radiogroup keyboard navigation: arrows step through the flat palette (Up/Down by
   * one honeycomb column pitch of 8), Home/End jump to the ends. Each handled key selects the
   * target color via `onChange` and moves DOM focus to its swatch, keeping focus on the checked
   * radio as the roving tabindex re-renders. Unhandled keys pass through untouched.
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
      nextIndex = Math.min(BRAND_PROFILE_COLORS.length - 1, currentIndex + 8);
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      nextIndex = Math.max(0, currentIndex - 8);
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
      className="flex flex-col items-center gap-2.5 rounded-control border border-line bg-surface/60 p-3 w-full max-w-full overflow-hidden"
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col items-center py-1">
        {HONEYCOMB_ROWS.map((row, rowIndex) => (
          <div key={rowIndex} className="flex items-center justify-center gap-1.5 -mt-2.25">
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
                    // `[&_svg]:size-4`) so the hexagon SVG fills the full 42x48 lattice cell.
                    // `bg-transparent hover:bg-transparent` removes the rectangular button
                    // hover background so only the cell size-up (scale-110) provides feedback.
                    "group relative flex h-12 w-10.5 items-center justify-center p-0 cursor-pointer bg-transparent hover:bg-transparent transition-transform duration-150 focus:outline-none focus-visible:scale-110 focus-visible:ring-0 focus-visible:z-20 shrink-0 [&_svg]:size-full",
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

      <div className="flex w-full items-center justify-between px-1.5 pt-1.5 border-t border-line/60">
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
