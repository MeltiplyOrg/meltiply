// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BRAND_PROFILE_COLORS } from "@/types";
import { BrandProfileColorPicker } from "./brand-profile-color-picker";

afterEach(cleanup);

describe("Brand Profile palette layout", () => {
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
