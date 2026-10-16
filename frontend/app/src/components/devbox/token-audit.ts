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

/** Color-valued CSS custom properties that form the approved token ramp. */
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
  "--line",
  "--line-strong",
  "--line-soft",
  "--accent",
  "--accent-ink",
  "--accent-tint",
  "--green",
  "--green-tint",
  "--orange",
  "--orange-tint",
  "--red",
  "--red-tint",
  "--platform-facebook",
  "--platform-instagram",
  "--platform-tiktok",
  "--platform-youtube",
  "--platform-linkedin",
  "--tooltip-bg",
  "--tooltip-fg",
  "--tooltip-muted",
  "--tooltip-border",
] as const;

const colorProperties = ["color", "backgroundColor", "borderColor"] as const;

type ColorProperty = (typeof colorProperties)[number];

// One detached probe reused for every canonicalization — creating an element
// per call would allocate thousands of nodes during a DOM audit walk.
let colorProbe: HTMLSpanElement | null = null;

/**
 * Canonicalizes a CSS color string by round-tripping it through a detached
 * probe element, so `oklch(...)`, `rgb(...)`, and `color-mix(...)` results
 * compare equal when they resolve to the same paint. Falls back to the raw
 * string when the environment cannot resolve the value (jsdom).
 */
function canonicalizeColor(value: string): string {
  if (typeof document === "undefined") return value.trim();
  colorProbe ??= document.createElement("span");
  colorProbe.style.color = value;
  const resolved = colorProbe.style.color;
  return (resolved || value).trim();
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
    const raw = styles.getPropertyValue(name).trim();
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

/** Utility prefixes that paint each audited CSS property. */
const propertyPrefixes: Record<ColorProperty, string> = {
  color: "text-",
  backgroundColor: "bg-",
  borderColor: "border-",
};

// Token utility suffixes derived from the token ramp (`--accent-tint` →
// `accent-tint`), used to recognize opacity-modified token classes.
const tokenSuffixes = new Set(tokenVariableNames.map((name) => name.slice(2)));

/**
 * Reports whether the element carries a token utility class for this property,
 * including opacity-modified forms (`bg-accent/5`, `border-line/50`). Those
 * resolve to alpha-blended colors that match no raw token value, but they are
 * still tokenized — flagging them would be a false positive.
 */
function usesTokenClass(element: Element, property: ColorProperty): boolean {
  const prefix = propertyPrefixes[property];
  for (const name of element.classList) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length).split("/")[0];
    if (tokenSuffixes.has(suffix)) return true;
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

/**
 * Flashes a persistent accent outline on violating elements so they can be
 * located visually. Pass an empty array to clear all highlights.
 */
export function highlightTokenViolations(violations: TokenViolation[]): void {
  ensureStyleTag(
    highlightStyleId,
    `[${highlightAttribute}] { outline: 2px dashed var(--red) !important; outline-offset: 1px; }`,
  );
  for (const el of document.querySelectorAll(`[${highlightAttribute}]`)) {
    el.removeAttribute(highlightAttribute);
  }
  for (const violation of violations) {
    violation.element.setAttribute(highlightAttribute, "");
  }
}
