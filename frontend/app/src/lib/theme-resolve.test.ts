import { resolveTheme } from "@meltiply/ui/theme-controller";
import { describe, expect, it } from "vite-plus/test";

describe("resolveTheme", () => {
  it.each([
    ["a stored light choice on a dark system", "light", true, "light"],
    ["a stored dark choice on a light system", "dark", false, "dark"],
    ["the system choice on a dark system", "system", true, "dark"],
    ["no choice on a dark system", null, true, "dark"],
    ["no choice on a light system", null, false, "light"],
  ] as const)("%s", (_example, preference, prefersDark, theme) => {
    expect(resolveTheme(preference, prefersDark)).toEqual(theme);
  });
});
