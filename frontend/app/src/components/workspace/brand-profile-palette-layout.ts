/**
 * Palette arrangements for the Brand Profile color picker.
 *
 * The picker renders all 51 contract colors once and reflows them by the
 * dialog's available content width. Wide dialogs keep the signature 9/8
 * honeycomb; narrower dialogs switch to progressively fewer flat columns so
 * each swatch keeps a usable touch target instead of shrinking the honeycomb
 * lattice. One column remains for the most constrained zoomed viewports.
 */
export type PaletteLayout =
  | "honeycomb"
  | "grid-6"
  | "grid-5"
  | "grid-4"
  | "grid-3"
  | "grid-2"
  | "grid-1";

/** The palette's fixed column gap at a 16px root font (`0.375rem`). */
const PALETTE_GAP_REM = 0.375;

/** The capped swatch width at a 16px root font (`2.625rem`). */
const PALETTE_CELL_REM = 2.625;

/**
 * Minimum content width, in rem, for each arrangement's capped swatches.
 *
 * The honeycomb's widest row is nine cells; every flat arrangement uses its
 * column count. Gaps count as `columns - 1`. Both the CSS cap/gap and these
 * thresholds are rem-based, so a changed root font size scales the selected
 * arrangement with the rendered cells.
 */
export const PALETTE_MIN_CONTENT_WIDTH_REM = {
  honeycomb: 9 * PALETTE_CELL_REM + 8 * PALETTE_GAP_REM, // 26.625rem
  "grid-6": 6 * PALETTE_CELL_REM + 5 * PALETTE_GAP_REM, // 17.625rem
  "grid-5": 5 * PALETTE_CELL_REM + 4 * PALETTE_GAP_REM, // 14.625rem
  "grid-4": 4 * PALETTE_CELL_REM + 3 * PALETTE_GAP_REM, // 11.625rem
  "grid-3": 3 * PALETTE_CELL_REM + 2 * PALETTE_GAP_REM, // 8.625rem
  "grid-2": 2 * PALETTE_CELL_REM + PALETTE_GAP_REM, // 5.625rem
  "grid-1": PALETTE_CELL_REM, // 2.625rem
} as const satisfies Record<PaletteLayout, number>;

/**
 * Chooses the palette arrangement for the picker's content width.
 *
 * Thresholds are the widest fixed-column arrangement that still fits at the
 * capped swatch size. The picker supplies its measured content-box width and
 * the root font size; both are resolved in rem so changing the root font size
 * selects columns from the same sizing units the CSS renders.
 *
 * @param contentWidth - Picker content width in px (root client width minus padding).
 * @param remSize - Root font size in px. Defaults to the browser's 16px baseline.
 * @returns The layout whose capped cells fit the available width.
 */
export function resolvePaletteLayout(contentWidth: number, remSize = 16): PaletteLayout {
  const widthRem = contentWidth / Math.max(remSize, 1);
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM.honeycomb) return "honeycomb";
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM["grid-6"]) return "grid-6";
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM["grid-5"]) return "grid-5";
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM["grid-4"]) return "grid-4";
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM["grid-3"]) return "grid-3";
  if (widthRem >= PALETTE_MIN_CONTENT_WIDTH_REM["grid-2"]) return "grid-2";
  return "grid-1";
}

/**
 * Column count of each arrangement; also the vertical arrow-key stride, since
 * Up/Down move one palette row while Left/Right stay in flat palette order.
 * The honeycomb alternates 9/8 cells, so 8 is its smaller vertical pitch.
 */
const PALETTE_COLUMNS = {
  honeycomb: 8,
  "grid-6": 6,
  "grid-5": 5,
  "grid-4": 4,
  "grid-3": 3,
  "grid-2": 2,
  "grid-1": 1,
} as const satisfies Record<PaletteLayout, number>;

/**
 * Returns the active column count for a palette arrangement.
 *
 * @param layout - Current palette arrangement.
 * @returns Columns per row, used as the Up/Down arrow step.
 */
export function paletteColumnStep(layout: PaletteLayout): number {
  return PALETTE_COLUMNS[layout];
}
