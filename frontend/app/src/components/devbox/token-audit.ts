import { elementSelector, ensureStyleTag } from "./dom";

const cssVariablePattern = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g;
const fractionalNumberPattern = /-?\d*\.\d+(?:e[-+]?\d+)?/gi;
const textColorDeclarationPattern = /(?:^|;)\s*color\s*:/i;
const backgroundDeclarationPattern = /(?:^|;)\s*background(?:-color)?\s*:/i;
const borderDeclarationPattern =
  /(?:^|;)\s*border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end|x|y))?(?:-color)?\s*:/i;
const leadingImportantPattern = /^!/;
const trailingImportantPattern = /!$/;

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
  "--on-accent",
  "--green",
  "--green-tint",
  "--green-tint-solid",
  "--orange",
  "--orange-tint",
  "--red",
  "--red-tint",
  "--red-tint-solid",
  "--teal",
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

const canonicalColorCache = new Map<string, string>();

function resolveCssVariables(value: string, styles: CSSStyleDeclaration, depth = 0): string {
  if (depth >= 8 || !value.includes("var(")) return value;
  return value.replace(cssVariablePattern, (_match, name: string, fallback: string | undefined) => {
    const replacement = styles.getPropertyValue(name).trim() || fallback?.trim() || "";
    return replacement ? resolveCssVariables(replacement, styles, depth + 1) : "";
  });
}

function normalizeColorSerialization(value: string): string {
  return value.replace(fractionalNumberPattern, (match) => {
    const rounded = Math.round(Number(match) * 10_000) / 10_000;
    return Number.isFinite(rounded) ? String(rounded) : match;
  });
}

function canonicalizeColor(value: string): string {
  const key = value.trim();
  const cached = canonicalColorCache.get(key);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return key;
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
  byColor: Map<string, string[]>;
  resolved: number;
}

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
  computed: string;
  tokens: string[];
}

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
  selector: string;
  reports: ElementColorReport[];
}

const propertyUtilityPatterns: Record<ColorProperty, RegExp> = {
  color: /^text-(.+)$/,
  backgroundColor: /^bg-(.+)$/,
  borderColor: /^border(?:-[trblxyse])?-(.+)$/,
};

const tokenSuffixes: Record<string, true> = Object.fromEntries(
  tokenVariableNames.map((name) => [name.slice(2), true]),
);

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

function matchesSelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

const breakpointMinWidth: Record<string, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

function mediaMatches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

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

function setsColorInline(element: Element, property: ColorProperty): boolean {
  const style = element.getAttribute("style");
  if (!style) return false;
  const declaration =
    property === "color"
      ? textColorDeclarationPattern
      : property === "backgroundColor"
        ? backgroundDeclarationPattern
        : borderDeclarationPattern;
  return declaration.test(style);
}

function activeUtilityBase(className: string, element: Element): string | null {
  const parts = splitClassParts(className);
  const base = parts.pop() ?? "";
  const normalized = base
    .replace(leadingImportantPattern, "")
    .replace(trailingImportantPattern, "");
  return parts.every((variant) => variantApplies(variant, element)) ? normalized : null;
}

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

function removeTokenMarks(): void {
  for (const el of document.querySelectorAll(`[${highlightAttribute}]`)) {
    el.removeAttribute(highlightAttribute);
  }
}

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

export function clearTokenHighlights(): void {
  removeTokenMarks();
  document.getElementById(highlightStyleId)?.remove();
}
