// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BRAND_PROFILE_COLORS } from "@/types";
import { BrandProfileColorPicker } from "./brand-profile-color-picker";
import {
  PALETTE_MIN_CONTENT_WIDTH_REM,
  paletteColumnStep,
  resolvePaletteLayout,
  type PaletteLayout,
} from "./brand-profile-palette-layout";

afterEach(cleanup);

describe("Brand Profile palette layout", () => {
  it("chooses the widest arrangement that still fits its content width", () => {
    const rem = 16;
    const thresholds: ReadonlyArray<readonly [PaletteLayout, PaletteLayout | null, number]> = [
      ["honeycomb", "grid-6", PALETTE_MIN_CONTENT_WIDTH_REM.honeycomb],
      ["grid-6", "grid-5", PALETTE_MIN_CONTENT_WIDTH_REM["grid-6"]],
      ["grid-5", "grid-4", PALETTE_MIN_CONTENT_WIDTH_REM["grid-5"]],
      ["grid-4", "grid-3", PALETTE_MIN_CONTENT_WIDTH_REM["grid-4"]],
      ["grid-3", "grid-2", PALETTE_MIN_CONTENT_WIDTH_REM["grid-3"]],
      ["grid-2", "grid-1", PALETTE_MIN_CONTENT_WIDTH_REM["grid-2"]],
      ["grid-1", null, PALETTE_MIN_CONTENT_WIDTH_REM["grid-1"]],
    ];

    for (const [layout, fallback, minimumRem] of thresholds) {
      expect(resolvePaletteLayout(minimumRem * rem, rem)).toBe(layout);
      if (fallback) expect(resolvePaletteLayout(minimumRem * rem - 1, rem)).toBe(fallback);
    }
  });

  it("resolves the same thresholds in rem when the root font size changes", () => {
    expect(resolvePaletteLayout(426, 16)).toBe("honeycomb");
    // 426px is 21.3rem at a 20px root: no longer the honeycomb's 26.625rem.
    expect(resolvePaletteLayout(426, 20)).toBe("grid-6");
    // 234px is 14.625rem at 16px, but only 11.7rem at 20px.
    expect(resolvePaletteLayout(234, 16)).toBe("grid-5");
    expect(resolvePaletteLayout(234, 20)).toBe("grid-4");
  });

  it("steps vertical arrows by each layout's column count", () => {
    const strides: ReadonlyArray<readonly [PaletteLayout, number]> = [
      ["honeycomb", 8],
      ["grid-6", 6],
      ["grid-5", 5],
      ["grid-4", 4],
      ["grid-3", 3],
      ["grid-2", 2],
      ["grid-1", 1],
    ];

    for (const [layout, stride] of strides) {
      expect(paletteColumnStep(layout)).toBe(stride);
    }
  });

  it("renders every contract color as a radio regardless of the chosen layout", () => {
    render(
      <BrandProfileColorPicker
        value={BRAND_PROFILE_COLORS[0]!}
        onChange={() => {}}
        label="Choose a profile color"
      />,
    );

    expect(screen.getAllByRole("radio")).toHaveLength(51);
    expect(screen.getAllByRole("radio")).toHaveLength(BRAND_PROFILE_COLORS.length);
  });
});
