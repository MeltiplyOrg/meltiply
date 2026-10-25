/**
 * Design-token inspector and DOM token audit for the DevBox Helpers tab.
 *
 * The audit approximates the `@shadcn/lint` `no-raw-colors` contract at
 * runtime: it resolves every declared color token (`--page`, `--ink*`,
 * `--line*`, `--accent*`, `--green/--orange/--red`, platform brand colors,
 * tooltip ramp) through a probe element, then walks the DOM comparing each
 * element's computed `color`, `background-color`, and `border-color` against
 * the approved set. Elements using non-tokenized colors are reported and can
 * be flashed with an outline.
 *
 * The element picker reports the token names matching a hovered element's
 * computed colors, plus any unmatched raw values.
 */

import { elementSelector, ensureStyleTag } from "./dom";

/**
 * Color-valued CSS custom properties that form the approved token ramp.
 * Mirrors every color entry in `frontend/shared/tokens.css` and the `@theme`
 * color aliases in `globals.css`; aliases are included because the audit
 * compares resolved paint, not the variable an element happened to use.
 */
const tokenVariableNames = [
  "--page",
  "--canvas",
  "--surface",
  "--inset",
  "--hover",
  "--hover-2",
  "--field",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--ink-inverse",
  "--charcoal",
  "--line",
  "--line-strong",
  "--line-soft",
  "--grid-line",
  "--accent",
  "--accent-ink",
  "--accent-tint",
  "--accent-tint-solid",
  "--accent-line",
  "--on-accent",
  "--green",
  "--green-tint",
  "--green-tint-solid",
  "--orange",
  "--orange-tint",
  "--red",
  "--red-tint",
  "--red-tint-solid",
  "--blue",
  "--violet",
  "--teal",
  "--rose",
  "--gray",
  "--platform-facebook",
  "--platform-instagram",
  "--platform-tiktok",
  "--platform-youtube",
  "--platform-linkedin",
  "--tooltip-bg",
  "--tooltip-fg",
  "--tooltip-muted",
  "--tooltip-border",
  "--overlay",
  // shadcn-compatible aliases exposed as utilities in globals.css.
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
] as const;

const colorProperties = ["color", "backgroundColor", "borderColor"] as const;

type ColorProperty = (typeof colorProperties)[number];

// Canonicalization depends only on the resolved input string; a theme swap
// changes the input (light/dark token values differ), so the cache stays valid.
const canonicalColorCache = new Map<string, string>();

/**
 * Expands `var(--name)` references inside a computed custom-property value.
 * Browsers substitute these already, but test DOMs and older engines can return
 * the literal token stream; the probe cannot resolve an unexpanded `var()`.
 *
 * @param value Raw custom-property value.
 * @param styles Declaration that owns the referenced variables.
 * @param depth Recursion guard for cyclic token aliases.
 * @returns The value with resolvable variable references replaced.
 */
function resolveCssVariables(value: string, styles: CSSStyleDeclaration, depth = 0): string {
  if (depth >= 8 || !value.includes("var(")) return value;
  return value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
    (_match, name: string, fallback: string | undefined) => {
      const replacement = styles.getPropertyValue(name).trim() || fallback?.trim() || "";
      return replacement ? resolveCssVariables(replacement, styles, depth + 1) : "";
    },
  );
}

/**
 * Normalizes numeric precision in a resolved color string. Browsers and test
 * DOMs serialize the same paint with different decimal precision depending on
 * whether it came from a token, `color-mix()`, or an inline value; comparing
 * four-decimal components keeps those forms equal.
 */
function normalizeColorSerialization(value: string): string {
  return value.replace(/-?\d*\.\d+(?:e[-+]?\d+)?/gi, (match) => {
    const rounded = Math.round(Number(match) * 10_000) / 10_000;
    return Number.isFinite(rounded) ? String(rounded) : match;
  });
}

/**
 * Canonicalizes a CSS color string by round-tripping it through a probe
 * element, so `oklch(...)`, `rgb(...)`, and `color-mix(...)` results compare
 * equal when they resolve to the same paint. The computed value is used
 * instead of the serialized inline value because only the former resolves
 * `color-mix()` into the painted color space. Falls back to the raw string when
 * the environment cannot resolve the value (jsdom without a color parser).
 */
function canonicalizeColor(value: string): string {
  const key = value.trim();
  const cached = canonicalColorCache.get(key);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return key;
  // A fresh probe is required because test DOMs cache computed styles on a
  // detached element; attaching it also makes browsers resolve `color-mix()`.
  // The cache keeps this to one probe per distinct color, and the node is
  // removed before any caller can observe or audit it.
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none";
  probe.style.color = key;
  const parsed = probe.style.color.trim();
  if (!parsed) {
    canonicalColorCache.set(key, key);
    return key;
  }
  (document.body ?? document.documentElement).appendChild(probe);
  let computed = "";
  try {
    computed = getComputedStyle(probe).color.trim();
  } finally {
    probe.remove();
  }
  const canonical = normalizeColorSerialization(computed || parsed);
  canonicalColorCache.set(key, canonical);
  return canonical;
}

export interface TokenColorMap {
  /** Canonicalized color string → token name(s). */
  byColor: Map<string, string[]>;
  /** Number of tokens that resolved to a concrete color. */
  resolved: number;
}

/**
 * Resolves every token variable to its computed color on the live document.
 * Tokens that fail to resolve (empty string) are skipped.
 */
export function collectTokenColors(root: HTMLElement = document.documentElement): TokenColorMap {
  const styles = getComputedStyle(root);
  const byColor = new Map<string, string[]>();
  let resolved = 0;
  for (const name of tokenVariableNames) {
    const raw = resolveCssVariables(styles.getPropertyValue(name).trim(), styles);
    if (!raw) continue;
    resolved += 1;
    const canonical = canonicalizeColor(raw);
    const names = byColor.get(canonical) ?? [];
    names.push(name);
    byColor.set(canonical, names);
  }
  return { byColor, resolved };
}

export interface ElementColorReport {
  property: ColorProperty;
  /** Computed color as reported by the browser. */
  computed: string;
  /** Matching token names, empty when the color is not tokenized. */
  tokens: string[];
}

/**
 * Evaluates one element's computed colors against the token map. Transparent
 * and inherited-default values (`rgba(0, 0, 0, 0)`) are ignored — they carry
 * no paint decision.
 */
export function inspectElementColors(
  element: Element,
  tokens: TokenColorMap,
): ElementColorReport[] {
  const styles = getComputedStyle(element);
  const reports: ElementColorReport[] = [];
  for (const property of colorProperties) {
    const computed = styles[property];
    if (!computed || computed === "rgba(0, 0, 0, 0)" || computed === "transparent") continue;
    reports.push({
      property,
      computed,
      tokens: tokens.byColor.get(canonicalizeColor(computed)) ?? [],
    });
  }
  return reports;
}

export interface TokenViolation {
  element: Element;
  /** `tag.class` hint for locating the element. */
  selector: string;
  reports: ElementColorReport[];
}

/** Utility matchers that paint each audited CSS property. */
const propertyUtilityPatterns: Record<ColorProperty, RegExp> = {
  color: /^text-(.+)$/,
  backgroundColor: /^bg-(.+)$/,
  borderColor: /^border(?:-[trblxyse])?-(.+)$/,
};

// Token utility suffixes derived from the token ramp (`--accent-tint` →
// `accent-tint`), used to recognize opacity-modified token classes.
const tokenSuffixes: Record<string, true> = Object.fromEntries(
  tokenVariableNames.map((name) => [name.slice(2), true]),
);

/**
 * Splits a utility class at top-level variant separators. Colons inside
 * arbitrary variants (`data-[state=active]`, `[&_svg]`) stay part of the
 * variant instead of being mistaken for separators.
 */
function splitClassParts(className: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < className.length; index += 1) {
    const char = className[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) {
      parts.push(className.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(className.slice(start));
  return parts;
}

/** Safe `matches` for states the current DOM implementation may not support. */
function matchesSelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** Tailwind's default viewport breakpoints, in pixels. */
const breakpointMinWidth: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

/** Safe media-query evaluation for environments without `matchMedia`. */
function mediaMatches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * Reports whether a Tailwind variant applies to the element right now. Unknown
 * or ancestor-dependent variants (`group-hover:`, peer selectors) return false:
 * assuming they are active would hide a genuine raw color. Container-query
 * variants (`@4xl:`) are layout-scoped, so their declared token utility is
 * treated as active; CSS still decides which one paints.
 */
function variantApplies(variant: string, element: Element): boolean {
  switch (variant) {
    case "hover":
      return matchesSelector(element, ":hover");
    case "focus":
      return matchesSelector(element, ":focus");
    case "focus-visible":
      return matchesSelector(element, ":focus-visible");
    case "active":
      return matchesSelector(element, ":active");
    case "disabled":
      return matchesSelector(element, ":disabled");
    case "dark":
      return matchesSelector(
        document.documentElement,
        ".dark, [data-theme='dark'], [data-palette='dark']",
      );
    case "portrait":
      return mediaMatches("(orientation: portrait)");
    case "landscape":
      return mediaMatches("(orientation: landscape)");
    case "print":
      return mediaMatches("print");
    case "motion-safe":
      return mediaMatches("(prefers-reduced-motion: no-preference)");
    case "motion-reduce":
      return mediaMatches("(prefers-reduced-motion: reduce)");
    case "contrast-more":
      return mediaMatches("(prefers-contrast: more)");
    case "contrast-less":
      return mediaMatches("(prefers-contrast: less)");
    case "pointer-coarse":
      return mediaMatches("(pointer: coarse)");
    case "pointer-fine":
      return mediaMatches("(pointer: fine)");
    default:
      break;
  }
  if (variant.startsWith("@")) return true;
  const minimum = breakpointMinWidth[variant];
  if (minimum !== undefined) return mediaMatches(`(min-width: ${minimum}px)`);
  if (variant.startsWith("max-")) {
    const maximum = breakpointMinWidth[variant.slice("max-".length)];
    if (maximum !== undefined) return mediaMatches(`(max-width: ${maximum - 0.02}px)`);
  }
  if (variant.startsWith("data-[")) {
    const condition = variant.slice("data-[".length, -1);
    return matchesSelector(element, `[data-${condition}]`);
  }
  if (variant.startsWith("data-")) {
    return matchesSelector(element, `[data-${variant.slice("data-".length)}]`);
  }
  return false;
}

/**
 * Reports whether the element's inline style declares the audited property.
 * Inline paint wins over utility classes, so a token class must not excuse it.
 */
function setsColorInline(element: Element, property: ColorProperty): boolean {
  const style = element.getAttribute("style");
  if (!style) return false;
  const declaration =
    property === "color"
      ? /(?:^|;)\s*color\s*:/i
      : property === "backgroundColor"
        ? /(?:^|;)\s*background(?:-color)?\s*:/i
        : /(?:^|;)\s*border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end|x|y))?(?:-color)?\s*:/i;
  return declaration.test(style);
}

/**
 * Returns the base utility when every variant on the class applies right now;
 * `null` when the class is inactive or is not a utility.
 */
function activeUtilityBase(className: string, element: Element): string | null {
  const parts = splitClassParts(className);
  const base = parts.pop() ?? "";
  const normalized = base.replace(/^!/, "").replace(/!$/, "");
  return parts.every((variant) => variantApplies(variant, element)) ? normalized : null;
}

/**
 * Reports whether the element carries an active token utility class for this
 * property. Opacity modifiers (`bg-accent/5`, `border-line/50`) are stripped
 * before matching, and side-specific border utilities (`border-x-line`,
 * `border-t-line`) count as border colors. Both resolve to alpha-blended or
 * side-scoped paints that match no raw token value, but they are still
 * tokenized — flagging them would be a false positive. Variant-prefixed
 * utilities only qualify while their variant actually applies, so an inactive
 * `hover:bg-accent/5` cannot excuse a raw background.
 */
function usesTokenClass(element: Element, property: ColorProperty): boolean {
  if (setsColorInline(element, property)) return false;
  const pattern = propertyUtilityPatterns[property];
  for (const name of element.classList) {
    const base = activeUtilityBase(name, element);
    if (!base) continue;
    const match = pattern.exec(base);
    if (!match) continue;
    const suffix = match[1].split("/")[0];
    if (tokenSuffixes[suffix]) return true;
  }
  return false;
}

/**
 * Walks the DOM under `root` and returns every element whose computed colors
 * fall outside the token ramp. The DevBox dock itself is excluded so its own
 * chrome never self-reports.
 */
export function auditTokenColors(
  tokens: TokenColorMap,
  root: ParentNode = document,
): TokenViolation[] {
  const violations: TokenViolation[] = [];
  const elements = root.querySelectorAll("body *");
  for (const element of elements) {
    if (element.closest("[data-devbox]")) continue;
    const reports = inspectElementColors(element, tokens).filter(
      (report) => report.tokens.length === 0 && !usesTokenClass(element, report.property),
    );
    if (reports.length > 0) {
      violations.push({ element, selector: elementSelector(element), reports });
    }
  }
  return violations;
}

const highlightAttribute = "data-devbox-token-violation";
const highlightStyleId = "devbox-token-violation-style";

/** Removes violation marks without removing the highlight stylesheet. */
function removeTokenMarks(): void {
  for (const el of document.querySelectorAll(`[${highlightAttribute}]`)) {
    el.removeAttribute(highlightAttribute);
  }
}

/**
 * Flashes a persistent accent outline on violating elements so they can be
 * located visually. Pass an empty array to clear all highlights.
 */
export function highlightTokenViolations(violations: TokenViolation[]): void {
  removeTokenMarks();
  if (violations.length === 0) {
    document.getElementById(highlightStyleId)?.remove();
    return;
  }
  ensureStyleTag(
    highlightStyleId,
    `[${highlightAttribute}] { outline: 2px dashed var(--red) !important; outline-offset: 1px; }`,
  );
  for (const violation of violations) {
    violation.element.setAttribute(highlightAttribute, "");
  }
}

/**
 * Removes every token-violation mark and the injected stylesheet. Called when
 * the owning tab or dock unmounts so audit mutations never outlive the tool.
 */
export function clearTokenHighlights(): void {
  removeTokenMarks();
  document.getElementById(highlightStyleId)?.remove();
}
