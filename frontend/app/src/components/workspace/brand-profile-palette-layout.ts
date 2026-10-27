/**
 * Palette arrangements for the Brand Profile color picker.
 *
 * The picker renders all 51 contract colors once and reflows them by the
 * dialog's available content width. Wide dialogs keep the signature 9/8
 * honeycomb; medium and phone dialogs switch to flat columns so each swatch
 * keeps a usable touch target instead of shrinking the honeycomb lattice.
 */
export type PaletteLayout = "honeycomb" | "grid-6" | "grid-5";

/** Content width, in px, at which six capped 42px columns no longer fit. */
export const HONEYCOMB_MIN_CONTENT_WIDTH = 426;

/** Content width, in px, at which five columns would otherwise fall below 42px. */
export const GRID_6_MIN_CONTENT_WIDTH = 282;

/**
 * Chooses the palette arrangement for the picker's content width.
 *
 * Thresholds are the widest fixed-column arrangement that still fits: the
 * 9/8 honeycomb spans 426px of content at 42px cells, and a six-column grid
 * spans 282px (6 × 42px + 5 × 6px gaps). Below that, five columns keep every
 * swatch near 42px even in a 320px dialog.
 *
 * @param contentWidth - Picker content width in px (root client width minus padding).
 * @returns The layout whose cells fit the available width.
 */
export function resolvePaletteLayout(contentWidth: number): PaletteLayout {
  if (contentWidth >= HONEYCOMB_MIN_CONTENT_WIDTH) return "honeycomb";
  if (contentWidth >= GRID_6_MIN_CONTENT_WIDTH) return "grid-6";
  return "grid-5";
}

/**
 * Column count of each arrangement; also the vertical arrow-key stride, since
 * Up/Down move one palette row while Left/Right stay in flat palette order.
 */
const PALETTE_COLUMNS: Record<PaletteLayout, number> = {
  honeycomb: 8,
  "grid-6": 6,
  "grid-5": 5,
};

/**
 * Returns the active column count for a palette arrangement.
 *
 * @param layout - Current palette arrangement.
 * @returns Columns per row, used as the Up/Down arrow step.
 */
export function paletteColumnStep(layout: PaletteLayout): number {
  return PALETTE_COLUMNS[layout];
}
