export type PaletteLayout =
  | "honeycomb"
  | "grid-6"
  | "grid-5"
  | "grid-4"
  | "grid-3"
  | "grid-2"
  | "grid-1";

const PALETTE_GAP_REM = 0.375;

const PALETTE_CELL_REM = 2.625;

const PALETTE_MIN_CONTENT_WIDTH_REM = {
  honeycomb: 9 * PALETTE_CELL_REM + 8 * PALETTE_GAP_REM,
  "grid-6": 6 * PALETTE_CELL_REM + 5 * PALETTE_GAP_REM,
  "grid-5": 5 * PALETTE_CELL_REM + 4 * PALETTE_GAP_REM,
  "grid-4": 4 * PALETTE_CELL_REM + 3 * PALETTE_GAP_REM,
  "grid-3": 3 * PALETTE_CELL_REM + 2 * PALETTE_GAP_REM,
  "grid-2": 2 * PALETTE_CELL_REM + PALETTE_GAP_REM,
  "grid-1": PALETTE_CELL_REM,
} as const satisfies Record<PaletteLayout, number>;

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

const PALETTE_COLUMNS = {
  honeycomb: 8,
  "grid-6": 6,
  "grid-5": 5,
  "grid-4": 4,
  "grid-3": 3,
  "grid-2": 2,
  "grid-1": 1,
} as const satisfies Record<PaletteLayout, number>;

export function paletteColumnStep(layout: PaletteLayout): number {
  return PALETTE_COLUMNS[layout];
}
