import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// Measure contrast from the shipped palette shared by both frontend renderers.
const themeCss = readFileSync(new URL("../../../shared/tokens.css", import.meta.url), "utf8");

/** Selects light/dark declarations for the consumer-visible contrast checks. */
function block(selector: string): string {
  const start = themeCss.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  return themeCss.slice(start, themeCss.indexOf("\n}", start));
}

type Rgba = [number, number, number, number];

/** Converts an OKLCH triple to a linear-light sRGB channel triple. */
function oklchToLinearSrgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

function channels(color: string): Rgba {
  const value = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const parsed = Number.parseInt(hex[1]!, 16);
    return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgba) {
    const parts = rgba[1]!.split(",").map((part) => Number.parseFloat(part));
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(value);
  if (oklch) {
    const [r, g, b] = oklchToLinearSrgb(
      Number.parseFloat(oklch[1]!),
      Number.parseFloat(oklch[2]!),
      Number.parseFloat(oklch[3]!),
    );
    const encode = (x: number) =>
      x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return [
      Math.min(1, Math.max(0, encode(r))) * 255,
      Math.min(1, Math.max(0, encode(g))) * 255,
      Math.min(1, Math.max(0, encode(b))) * 255,
      oklch[4] === undefined ? 1 : Number.parseFloat(oklch[4]),
    ];
  }
  throw new Error(`Unsupported colour: ${color}`);
}

function luminance(color: string, over: string): number {
  const [red, green, blue, alpha] = channels(color);
  const backdrop = channels(over);
  const composite = [red, green, blue].map(
    (value, index) => value * alpha + backdrop[index]! * (1 - alpha),
  );
  const [r, g, b] = composite.map((value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const light = luminance(foreground, background);
  const dark = luminance(background, background);
  const [brighter, darker] = light > dark ? [light, dark] : [dark, light];
  return (brighter + 0.05) / (darker + 0.05);
}

/**
 * Resolves a token to a concrete colour, following `var(--other)` references
 * within the same theme block (the `@theme inline` map aliases utilities to
 * raw tokens, so indirection is expected).
 */
function token(selector: string, name: string, depth = 0): string {
  expect(depth, `${name} var() chain`).toBeLessThan(8);
  const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(block(selector));
  expect(match, `${name} in ${selector}`).not.toBeNull();
  const value = match![1]!.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(selector, ref[1]!, depth + 1) : value;
}

describe("theme contrast", () => {
  // Page, canvas, inset and surface carry text: the viewport, the sidebar,
  // recessed fields, and raised cards.
  const textSurfaces = ["--page", "--canvas", "--inset", "--surface"];

  it.each([":root", ".dark"])("keeps %s body and muted text at AA", (selector) => {
    const foreground = token(selector, "--ink");
    const muted = token(selector, "--ink-2");

    for (const surface of textSurfaces) {
      const background = token(selector, surface);
      expect(
        contrast(foreground, background),
        `${selector} ${surface} body`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(muted, background), `${selector} ${surface} muted`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it.each([":root", ".dark"])("keeps %s text on the primary control readable", (selector) => {
    expect(
      contrast(token(selector, "--primary-foreground"), token(selector, "--primary")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
