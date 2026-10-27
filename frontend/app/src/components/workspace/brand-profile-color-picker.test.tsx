// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BRAND_PROFILE_COLORS } from "@/types";
import { BrandProfileColorPicker } from "./brand-profile-color-picker";
import {
  GRID_6_MIN_CONTENT_WIDTH,
  HONEYCOMB_MIN_CONTENT_WIDTH,
  paletteColumnStep,
  resolvePaletteLayout,
} from "./brand-profile-palette-layout";

afterEach(cleanup);

describe("Brand Profile palette layout", () => {
  it("chooses the widest arrangement that still fits its content width", () => {
    expect(resolvePaletteLayout(HONEYCOMB_MIN_CONTENT_WIDTH)).toBe("honeycomb");
    expect(resolvePaletteLayout(HONEYCOMB_MIN_CONTENT_WIDTH - 1)).toBe("grid-6");
    expect(resolvePaletteLayout(GRID_6_MIN_CONTENT_WIDTH)).toBe("grid-6");
    expect(resolvePaletteLayout(GRID_6_MIN_CONTENT_WIDTH - 1)).toBe("grid-5");
  });

  it("steps vertical arrows by the active column count", () => {
    expect(paletteColumnStep("honeycomb")).toBe(8);
    expect(paletteColumnStep("grid-6")).toBe(6);
    expect(paletteColumnStep("grid-5")).toBe(5);
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
