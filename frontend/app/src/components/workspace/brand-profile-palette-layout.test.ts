import { describe, expect, it } from "vite-plus/test";

import { paletteColumnStep, resolvePaletteLayout } from "./brand-profile-palette-layout";

describe("resolvePaletteLayout", () => {
  it.each([
    ["the narrowest honeycomb", 426, 16, "honeycomb"],
    ["one pixel short of honeycomb", 425, 16, "grid-6"],
    ["the narrowest grid-6", 282, 16, "grid-6"],
    ["one pixel short of grid-6", 281, 16, "grid-5"],
    ["the narrowest grid-5", 234, 16, "grid-5"],
    ["one pixel short of grid-5", 233, 16, "grid-4"],
    ["the narrowest grid-4", 186, 16, "grid-4"],
    ["one pixel short of grid-4", 185, 16, "grid-3"],
    ["the narrowest grid-3", 138, 16, "grid-3"],
    ["one pixel short of grid-3", 137, 16, "grid-2"],
    ["the narrowest grid-2", 90, 16, "grid-2"],
    ["one pixel short of grid-2", 89, 16, "grid-1"],
    ["the narrowest grid-1", 42, 16, "grid-1"],
    ["no width", 0, 16, "grid-1"],
    ["426 pixels at a 16 pixel root", 426, 16, "honeycomb"],
    ["426 pixels at a 20 pixel root", 426, 20, "grid-6"],
    ["234 pixels at a 20 pixel root", 234, 20, "grid-4"],
    ["a root size of zero", 27, 0, "honeycomb"],
  ])("%s", (_example, contentWidth, remSize, layout) => {
    expect(resolvePaletteLayout(contentWidth, remSize)).toEqual(layout);
  });

  it("a default root size", () => {
    expect(resolvePaletteLayout(234)).toEqual("grid-5");
  });
});

describe("paletteColumnStep", () => {
  it.each([
    ["honeycomb", 8],
    ["grid-6", 6],
    ["grid-5", 5],
    ["grid-4", 4],
    ["grid-3", 3],
    ["grid-2", 2],
    ["grid-1", 1],
  ] as const)("the %s layout", (layout, step) => {
    expect(paletteColumnStep(layout)).toEqual(step);
  });
});
