import { createThemeInkMask } from "./theme-ink-mask";
import type { Theme, ThemeTransitionOrigin } from "./theme-transition";

/**
 * Clone ids and control names are prefixed so no document-wide lookup, radio
 * group, or fragment reference can collide with — or mutate — live elements.
 */
const cloneIdPrefix = "theme-ink-";

/**
 * Elements that can never contribute paint or must never execute a second
 * time. STYLE is dropped because the live document's rules still apply to
 * the clone through shared selectors, while id/name-keyed rules are
 * re-emitted per sheet into the `theme-ink-` namespace by the mirror pass —
 * duplicating the source text itself is pure churn.
 */
const droppedTags: Record<string, true> = {
  SCRIPT: true,
  STYLE: true,
  META: true,
  LINK: true,
  BASE: true,
  "ASTRO-DEV-TOOLBAR": true,
};

/**
 * `name` namespaces that would otherwise leak semantics into the live tree —
 * a cloned radio sharing `name` with a live input joins its radio group and
 * unchecks the live control the moment clone state is mirrored.
 */
const namedControlTags: Record<string, true> = {
  INPUT: true,
  BUTTON: true,
  SELECT: true,
  TEXTAREA: true,
  FIELDSET: true,
  OUTPUT: true,
  OBJECT: true,
  FORM: true,
  MAP: true,
  IFRAME: true,
};

/** Attributes whose value is a whitespace-separated list of id references. */
const idListAttributes: Record<string, true> = {
  for: true,
  form: true,
  list: true,
  headers: true,
  itemref: true,
  popovertarget: true,
  commandfor: true,
  "aria-labelledby": true,
  "aria-describedby": true,
  "aria-details": true,
  "aria-controls": true,
  "aria-owns": true,
  "aria-activedescendant": true,
  "aria-flowto": true,
};

/** Attributes holding a single `#id` fragment reference. */
const fragmentAttributes: Record<string, true> = {
  href: true,
  "xlink:href": true,
  usemap: true,
};

/** Presentation/style attributes that can embed `url(#id)` references. */
const urlAttributes: Record<string, true> = {
  "clip-path": true,
  mask: true,
  filter: true,
  fill: true,
  stroke: true,
  "marker-start": true,
  "marker-mid": true,
  "marker-end": true,
  cursor: true,
};

const fragmentUrlPattern = /url\(\s*(['"]?)#([^\s'")]+)\1\s*\)/g;

/**
 * Marks the generated `<style>` elements that carry id-referencing source
 * rules rewritten into the clone namespace. The body's mutation observer
 * uses it to skip records caused purely by mirror churn, and the sheet walk
 * skips mirrors as sources so a rebuild can never re-mirror its own output.
 */
const mirrorStyleMarker = "data-theme-ink-rules";

/**
 * Remaps `url(#id)` fragment references exactly as cloned attributes do:
 * only references whose target element was cloned are prefixed, so artwork
 * backed by dropped or external nodes keeps resolving against the live tree.
 * Shared by attribute rewriting and mirrored declaration emission.
 */
function rewriteFragmentUrls(
  value: string,
  ids: Map<string, string>,
  names: Map<string, string>,
): string {
  return value.replace(fragmentUrlPattern, (match, _quote, id: string) => {
    const mapped = ids.get(id) ?? names.get(id);
    // Quoted emission keeps ids containing spaces or quotes a valid url().
    return mapped ? `url("${mapped.replace(/\\/g, "\\\\").replaceAll('"', '\\"')}")` : match;
  });
}

/** Mirrored nested scrollport: live element → cloned counterpart. */
interface ScrollPair {
  source: HTMLElement;
  clone: HTMLElement;
  pendingX: number;
  pendingY: number;
}

/**
 * Viewport-bound (fixed) or scrollport-bound (sticky) element whose clone may
 * drift from its live counterpart — e.g. when the LIVE root/body is itself
 * transformed, which makes real fixed elements bind the transformed ancestor
 * instead of the viewport. `baseX/baseY` preserve the authored `translate` so
 * the correction composes instead of overwriting; `appliedX/appliedY`
 * accumulate the live-vs-clone rect delta that converges each sync.
 */
interface CorrectedPair {
  source: Element;
  clone: HTMLElement | SVGElement;
  baseX: number;
  baseY: number;
  appliedX: number;
  appliedY: number;
}

/** Options for one masked target-theme copy of the live document. */
export interface ThemeInkLayerOptions {
  /** The theme the clone renders; the live root keeps its source theme. */
  readonly theme: Theme;
  /** Fixed activation point in VIEWPORT coordinates; document scrolling never moves the mask. */
  readonly origin: ThemeTransitionOrigin;
  /** Resolves target-root custom properties lazily inside the first frame, keeping the click task light. */
  readonly palette: () => Record<string, string>;
}

/**
 * One inert full-document visual layer. The overlay and mask mount
 * synchronously for a zero-cost first frame; palette resolution, clone
 * building and the scroll/correction scan defer to the layer's first
 * animation frame, so a theme click never blocks on ~400 computed styles.
 * `sync` mirrors window + nested scrolling and viewport-bound corrections;
 * `paint` publishes mask state; `destroy` removes the layer, listeners,
 * observers and any pending prime without ever touching live paint.
 */
export interface ThemeInkLayer {
  /** Fixed viewport overlay, sibling of `document.body`. */
  readonly element: HTMLDivElement;
  /** Document-space radius covering every painted pixel; never shrinks. */
  readonly extent: number;
  /** Mirrors current scroll state into the clone; idempotent, synchronous. */
  sync(): void;
  /** Publishes the mask radius; hides the layer at radius ≤ 0 to avoid flash. */
  paint(radius: number): void;
  /** Removes the layer and every listener/observer; idempotent. */
  destroy(): void;
}

/**
 * Rewrites one attribute value for the cloned namespace: `id` is always
 * prefixed, fragment/id-list/`url(#…)` references are remapped only when their
 * target was cloned (otherwise the reference falls through to the live
 * element, preserving SVG/ARIA fidelity), and control `name`s are prefixed
 * unconditionally so clone groups stay isolated from live form state.
 */
function rewriteAttributeValue(
  clone: Element,
  name: string,
  value: string,
  ids: Map<string, string>,
  names: Map<string, string>,
): string {
  if (name === "id") return cloneIdPrefix + value;
  if (name === "name" && namedControlTags[clone.tagName.toUpperCase()])
    return cloneIdPrefix + value;
  if (idListAttributes[name])
    return value
      .split(/\s+/)
      .map((token) => ids.get(token) ?? names.get(token) ?? token)
      .join(" ");
  if (fragmentAttributes[name] && value.startsWith("#")) {
    const mapped = ids.get(value.slice(1)) ?? names.get(value.slice(1));
    return mapped ? `#${mapped}` : value;
  }
  if (urlAttributes[name] || name === "style")
    // Fragment `url(#id)` references remap only when their target was cloned;
    // otherwise they keep resolving against the live element's artwork.
    return rewriteFragmentUrls(value, ids, names);
  return value;
}

/** Consumes one CSS escape starting at `start` (the `\` index): up to six hex digits plus one whitespace, or a single escaped code point. */
function skipCssEscape(text: string, start: number): number {
  let index = start + 1;
  if (index >= text.length) return index;
  if (/[0-9a-fA-F]/.test(text[index]!)) {
    while (index < text.length && /[0-9a-fA-F]/.test(text[index]!) && index - start <= 6)
      index += 1;
    if (index < text.length && /\s/.test(text[index]!)) index += 1;
    return index;
  }
  return index + 1;
}

/** Returns the index just past the closing quote of a quoted run starting at `start`, honoring backslash escapes. */
function skipQuotedText(text: string, start: number): number {
  const quote = text[start]!;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") index = skipCssEscape(text, index);
    else if (text[index] === quote) return index + 1;
    else index += 1;
  }
  return index;
}

/** Finds the end of an identifier run starting at `start`, including any escaped code points. */
/** Finds the end of an identifier run starting at `start`, including escaped and non-ASCII code points (both valid in CSS idents). */
function readIdentEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === "\\") {
      index = skipCssEscape(text, index);
      continue;
    }
    if (!/[\w-]/.test(text[index]!) && text.charCodeAt(index) < 0x80) break;
    index += 1;
  }
  return index;
}

/** Decodes backslash escapes (hex runs or literal characters) inside a captured selector identifier. */
function unescapeCssIdent(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_all, seq: string) =>
    /^[0-9a-fA-F]/.test(seq) ? String.fromCodePoint(Number.parseInt(seq, 16)) : seq,
  );
}

/**
 * Re-encodes an identifier for selector emission. Mirrored ids are prefixed
 * but keep characters like `:` that are only valid escaped, so every
 * non-ident character is backslash-escaped (controls as hex escapes).
 */
function escapeCssIdent(value: string): string {
  return value.replace(/[^\w-]/g, (ch) =>
    ch <= "\x1f" || ch === "\x7f" ? `\\${ch.codePointAt(0)!.toString(16)} ` : `\\${ch}`,
  );
}

/** Finds the index just past a bracketed selector's closing `]`, skipping quoted values and escapes. */
function scanBracketEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\\") index = skipCssEscape(text, index);
    else if (ch === '"' || ch === "'") index = skipQuotedText(text, index);
    else if (ch === "]") return index + 1;
    else index += 1;
  }
  return text.length;
}

/**
 * Attribute-selector shape: name (namespaces kept, `|` only ends the name
 * when it starts the `|=` operator), matcher, quoted or unquoted value, and
 * an optional case flag. Anything not matching is copied verbatim.
 */
const attributePattern =
  /^\s*((?:[^\s~^$*!=\]]|\|(?!=))+)\s*(\|=|[~^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([iIsS])?\s*$/;

/**
 * Rewrites the value of one attribute selector whose target attribute is
 * itself rewritten on clones. `id` is always prefixed on clones, `name` only
 * for controls, id-list attributes token-wise, and fragment/`url(#)`/`style`
 * attributes through the same maps the attribute pass uses — so a selector
 * matches the cloned element iff the live selector would match the source.
 * Prefix matchers (`^=`, `|=`) prefix the probe unconditionally since clone
 * values carry a fixed prefix; suffix/substring matchers on `id` stay
 * verbatim because `theme-ink-<id>` preserves both. Returns null when the
 * value cannot map to a clone-side value, meaning the live selector itself
 * has no clone counterpart and the branch stays dead.
 */
function rewriteBracketValue(
  name: string,
  operator: string,
  value: string,
  ids: Map<string, string>,
  names: Map<string, string>,
): string | null {
  const local = name.includes("|") ? name.slice(name.lastIndexOf("|") + 1) : name;
  if (local === "id") {
    // Every cloned id carries the fixed prefix, so exact/prefix probes
    // prefix unconditionally; suffix/substring matches survive verbatim
    // inside `theme-ink-<id>`.
    if (operator === "$=" || operator === "*=") return value;
    return cloneIdPrefix + value;
  }
  if (local === "name") {
    // Only control names are prefixed; unknown names stay verbatim, matching
    // elements whose `name` the clone kept as-is.
    if (operator !== "=" && operator !== "~=") return null;
    return names.get(value) ?? value;
  }
  if (idListAttributes[local]) {
    if (operator === "=" || operator === "~=")
      return value
        .split(/\s+/)
        .map((token) => ids.get(token) ?? names.get(token) ?? token)
        .join(" ");
    if (operator === "^=" || operator === "|=") return cloneIdPrefix + value;
    return null;
  }
  if (fragmentAttributes[local]) {
    if (operator === "=" || operator === "~=") {
      if (!value.startsWith("#")) return null;
      const mapped = ids.get(value.slice(1)) ?? names.get(value.slice(1));
      return mapped ? `#${mapped}` : value;
    }
    return value.startsWith("#") ? `#${cloneIdPrefix}${value.slice(1)}` : null;
  }
  if (urlAttributes[local] || local === "style") {
    if (operator === "=" || operator === "~=") return rewriteFragmentUrls(value, ids, names);
    return value.includes("#")
      ? value.replace(/#([^\s'"#]+)/g, (_all, rest: string) => `#${cloneIdPrefix}${rest}`)
      : null;
  }
  return null;
}

/**
 * Rebuilds one `[attr op "value" flag]` selector through the clone's id/name
 * namespace. Returns null when nothing inside changes — including when the
 * attribute is never rewritten on clones, where `#` is literal text.
 */
function rewriteBracketSelector(
  inner: string,
  ids: Map<string, string>,
  names: Map<string, string>,
): string | null {
  const match = attributePattern.exec(inner);
  if (!match) return null;
  const [, rawName, operator, rawValue, flag] = match;
  const value = unescapeCssIdent(
    rawValue!.startsWith('"') || rawValue!.startsWith("'") ? rawValue!.slice(1, -1) : rawValue!,
  );
  const mapped = rewriteBracketValue(rawName!, operator!, value, ids, names);
  if (mapped === null || mapped === value) return null;
  // Emitted values always go out double-quoted: quoted strings accept every
  // remapped character without per-char ident escaping inside brackets.
  const nextValue = `"${mapped.replace(/\\/g, "\\\\").replaceAll('"', '\\"')}"`;
  return `[${rawName}${operator}${nextValue}${flag ? ` ${flag}` : ""}]`;
}

/**
 * Rewrites one complex selector into the clone namespace: `#id` tokens remap
 * through the clone's id map (escapes decoded, unmapped ids copied verbatim),
 * and bracketed attribute selectors defer to `rewriteBracketSelector`.
 * Returns rewritten text and whether any cloned reference changed.
 */
function rewriteSelector(
  selector: string,
  ids: Map<string, string>,
  names: Map<string, string>,
): { text: string; changed: boolean } {
  let out = "";
  let changed = false;
  let index = 0;
  while (index < selector.length) {
    const ch = selector[index]!;
    if (ch === '"' || ch === "'") {
      const end = skipQuotedText(selector, index);
      out += selector.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "\\") {
      const end = skipCssEscape(selector, index);
      out += selector.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "[") {
      const end = scanBracketEnd(selector, index);
      const next = rewriteBracketSelector(selector.slice(index + 1, end - 1), ids, names);
      out += next ?? selector.slice(index, end);
      changed ||= next !== null;
      index = end;
      continue;
    }
    if (ch === "#") {
      const end = readIdentEnd(selector, index + 1);
      const raw = selector.slice(index + 1, end);
      const mapped = raw ? ids.get(unescapeCssIdent(raw)) : undefined;
      out += mapped ? `#${escapeCssIdent(mapped)}` : selector.slice(index, end);
      changed ||= mapped !== undefined;
      index = end;
      continue;
    }
    out += ch;
    index += 1;
  }
  return { text: out, changed };
}

/**
 * Appends a zero-specificity ancestor predicate to the subject compound of
 * one emitted complex selector: `<subject>:where([data-theme-ink-layer] *)`.
 * Unchanged sibling branches kept inside `:is()`/`:where()`/`:has()` would
 * otherwise re-apply declarations to live elements (identical text, but a
 * later live rule could lose the tie it won on the source), so mirrored
 * subjects must never match outside the overlay. The guard is a predicate
 * on the subject — not a chain prefix — so authored ancestors like
 * `html.dark #id` keep their live meaning. Insertion lands before any
 * trailing pseudo-element so `::before`/`::marker` rules still emit clone
 * pseudo content, and splicing after the last top-level combinator keeps
 * `>`/`+`/`~` semantics untouched.
 */
function guardCloneSubject(selector: string): string {
  let subjectStart = 0;
  let parens = 0;
  let brackets = 0;
  let index = 0;
  while (index < selector.length) {
    const ch = selector[index]!;
    if (ch === "\\") {
      index = skipCssEscape(selector, index);
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = skipQuotedText(selector, index);
      continue;
    }
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets = Math.max(0, brackets - 1);
    else if (parens === 0 && brackets === 0) {
      if (ch === ">" || ch === "+" || ch === "~") {
        index += 1;
        while (index < selector.length && /\s/.test(selector[index]!)) index += 1;
        subjectStart = index;
        continue;
      }
      if (/\s/.test(ch)) {
        let probe = index;
        while (probe < selector.length && /\s/.test(selector[probe]!)) probe += 1;
        const next = selector[probe];
        if (next !== undefined && next !== ">" && next !== "+" && next !== "~")
          subjectStart = probe;
      }
    }
    index += 1;
  }
  if (subjectStart >= selector.length) return selector;
  // A pseudo-element belongs to the subject but must stay after the guard.
  let insertAt = selector.length;
  parens = 0;
  index = subjectStart;
  while (index < selector.length) {
    const ch = selector[index]!;
    if (ch === "\\") {
      index = skipCssEscape(selector, index);
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = skipQuotedText(selector, index);
      continue;
    }
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (
      ch === ":" &&
      parens === 0 &&
      (selector[index + 1] === ":" ||
        /^:(before|after|first-line|first-letter)\b/i.test(selector.slice(index)))
    ) {
      insertAt = index;
      break;
    }
    index += 1;
  }
  return `${selector.slice(0, insertAt)}:where([data-theme-ink-layer] *)${selector.slice(insertAt)}`;
}

/** Splits a selector list on top-level commas, ignoring commas nested inside `:is()`/attribute brackets or quotes. */
function splitSelectorList(selectorText: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  for (let index = 0; index < selectorText.length; index += 1) {
    const ch = selectorText[index]!;
    if (ch === "\\") {
      index = skipCssEscape(selectorText, index) - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = skipQuotedText(selectorText, index) - 1;
      continue;
    }
    if (ch === "(") parens += 1;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets = Math.max(0, brackets - 1);
    else if (ch === "," && parens === 0 && brackets === 0) {
      parts.push(selectorText.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selectorText.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Rewrites each complex selector of a rule's selector list independently so
 * a shared `.a, #id` rule contributes only its id branch to the mirror —
 * the unchanged branches already match clone elements through the live
 * sheets, and re-emitting them could flip source-order ties. Every emitted
 * branch is subject-guarded to the overlay so unchanged `:is()` siblings or
 * forced verbatim branches can never match — or restyle — live elements.
 */
function rewriteSelectorBranches(
  selectorText: string,
  force: boolean,
  ids: Map<string, string>,
  names: Map<string, string>,
): { text: string; changed: boolean } {
  const kept: string[] = [];
  let changed = false;
  for (const branch of splitSelectorList(selectorText)) {
    const next = rewriteSelector(branch, ids, names);
    if (force || next.changed) kept.push(guardCloneSubject(next.text));
    changed ||= next.changed;
  }
  return { text: kept.join(","), changed };
}

/**
 * Locates a grouping rule's top-level `{` so its header (`@media …`,
 * `@scope …`, `@container …`, `@layer name`) can be preserved verbatim —
 * conditions keep evaluating live against the real viewport, container and
 * feature state — while only its id-referencing children are emitted inside.
 */
function mirroredRuleHeader(cssText: string): string | null {
  for (let index = 0; index < cssText.length; index += 1) {
    const ch = cssText[index]!;
    if (ch === "\\") {
      index = skipCssEscape(cssText, index) - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      index = skipQuotedText(cssText, index) - 1;
      continue;
    }
    if (ch === "{") return cssText.slice(0, index).trimEnd();
  }
  return null;
}

/**
 * Serializes the clone-facing subset of one sheet's rules. A rule enters the
 * mirror only when its selector (or, for `@scope`-style headers, its prelude)
 * references a cloned id/name/attribute; grouping rules emit a verbatim
 * header with recursively filtered children, so `@media`/`@supports`/
 * `@container`/`@layer` keep gating on live conditions. Once a rule is
 * mirrored (`force`), every nested rule is emitted with rewritten selectors
 * because the live copy can no longer reach those elements through the
 * un-prefixed selector. Declarations keep `url(#id)` fidelity via
 * `rewriteFragmentUrls`.
 */
function emitMirroredRules(
  rules: CSSRuleList,
  force: boolean,
  ids: Map<string, string>,
  names: Map<string, string>,
): string {
  let text = "";
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    const grouped = rule as CSSRule & { cssRules?: CSSRuleList };
    const styled = rule as CSSStyleRule;
    const selectorText = typeof styled.selectorText === "string" ? styled.selectorText : null;
    if (selectorText !== null) {
      const branches = rewriteSelectorBranches(selectorText, force, ids, names);
      const emitAll = force || branches.changed;
      const children = grouped.cssRules
        ? emitMirroredRules(grouped.cssRules, emitAll, ids, names)
        : "";
      if (!branches.text && !children) continue;
      const declarations = emitAll ? rewriteFragmentUrls(styled.style.cssText, ids, names) : "";
      const nested = declarations && children && !declarations.trimEnd().endsWith(";") ? ";" : "";
      text += `${branches.text || selectorText}{${declarations}${nested}${children}}`;
      continue;
    }
    const header = grouped.cssRules ? mirroredRuleHeader(rule.cssText) : null;
    if (header === null) {
      // Leaf rules carry no selector; they matter only inside a mirrored
      // ancestor (@starting-style, nested declaration blocks, @import).
      if (force) text += rewriteFragmentUrls(rule.cssText, ids, names);
      continue;
    }
    const own = rewriteSelector(header, ids, names);
    const emitAll = force || own.changed;
    const children = emitMirroredRules(grouped.cssRules!, emitAll, ids, names);
    if (!children && !emitAll) continue;
    text += `${own.text}{${children}}`;
  }
  return text;
}

/** Wraps mirrored sheet text in the sheet's own media condition when one exists, so `media=` scoping survives. */
function wrapMirroredText(text: string, mediaText: string): string {
  const media = mediaText.trim();
  return media && !/^all$/i.test(media) ? `@media ${media}{${text}}` : text;
}

/**
 * Mounts an inert full-body target-palette copy of the live document as a
 * fixed viewport overlay. The clone keeps native text, artwork and controls
 * visually identical under the target palette — no per-node computed paint
 * freezing — while a sharp mask on the layer decides coverage. Rules that
 * key on ids/names/fragment attributes are re-emitted into the `theme-ink-`
 * namespace beside their source sheets so layout, typography and dynamic
 * state that CSS alone resolves reach the prefixed clone unchanged. The
 * live tree is never restyled, refocused or repainted by this helper.
 * Dark targets expose the drop; light targets expose its complement, so the
 * committed dark source withdraws without changing its palette prematurely.
 * The control's viewport origin stays fixed during scrolling in both directions;
 * the full-document copy independently follows the live document's scrollports.
 */
export function createThemeInkLayer(options: ThemeInkLayerOptions): ThemeInkLayer {
  const docEl = document.documentElement;
  const element = document.createElement("div");
  let sourceToClone = new WeakMap<Node, Node>();
  let scrollPairs = new Map<HTMLElement, ScrollPair>();
  let correctedPairs: CorrectedPair[] = [];
  let correctedByClone = new WeakMap<Element, CorrectedPair>();
  let stubByClone = new WeakMap<Element, Element>();
  let ids = new Map<string, string>();
  let names = new Map<string, string>();
  const knownScrollers = new Set<Element>();
  let cloneBody: HTMLElement | null = null;
  let extentValue = 0;
  let settled = false;
  let forceSync = true;
  let lastSX = Number.NaN;
  let lastSY = Number.NaN;
  const cloneDocument = document.implementation.createHTMLDocument("");
  const inverse = options.theme === "light";
  const inkMask = createThemeInkMask(inverse);
  let currentRadius = 0;

  /** Last measured border-box size of the observed element; the baseline for filtering the ResizeObserver's install echo from real size changes. */
  let observedWidth = 0;
  let observedHeight = 0;

  /**
   * Generated `<style>` elements holding the id-referencing source rules
   * rewritten into the clone namespace, and the flag that marks them stale
   * when a live `id`/`name` attribute mutation changes the remap tables.
   */
  const mirrorStyles: HTMLStyleElement[] = [];
  let mirroredRulesStale = false;
  let rebuildFrame = 0;

  /**
   * Re-emits every stylesheet rule that keys on a cloned id/name/attribute
   * into the `theme-ink-` namespace — the live sheets can no longer reach the
   * prefixed clone ids — and mounts each mirror immediately after its
   * sheet's owner element so inter-rule cascade order survives verbatim
   * (adopted sheets land at the head end, matching adopted-sheet ordering).
   * `@media`/`@supports`/`@container`/`@layer`/`@scope` wrappers are kept so
   * conditions still evaluate against live viewport and DOM state. Runs on
   * clone (re)build and when live id/name attributes mutate; style inserts
   * are marker-filtered so the observer never loops on its own mirrors.
   */
  function mountMirroredRules(): void {
    mirroredRulesStale = false;
    while (mirrorStyles.length) mirrorStyles.pop()!.remove();
    const sheets: CSSStyleSheet[] = [...document.styleSheets];
    if (document.adoptedStyleSheets) sheets.push(...document.adoptedStyleSheets);
    for (const sheet of sheets) {
      const owner = sheet.ownerNode;
      if (owner instanceof Element && owner.hasAttribute(mirrorStyleMarker)) continue;
      if (sheet.disabled) continue;
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin sheets are unreadable; the clone keeps their gap.
        continue;
      }
      if (!rules) continue;
      let text = emitMirroredRules(rules, false, ids, names);
      if (!text) continue;
      text = wrapMirroredText(text, sheet.media?.mediaText ?? "");
      const style = document.createElement("style");
      style.setAttribute(mirrorStyleMarker, "");
      // Text content lands while the node is detached, keeping the
      // assignment outside the observed body subtree and out of sync().
      style.textContent = text;
      mirrorStyles.push(style);
      if (owner instanceof Element && owner.isConnected) owner.after(style);
      else (document.head ?? docEl).append(style);
    }
  }

  element.setAttribute("data-theme-ink-layer", options.theme);
  element.className = "theme-ink-layer";
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
  element.style.cssText =
    "position:fixed;inset:0;overflow:hidden;pointer-events:none;" +
    "z-index:2147483647;visibility:hidden;";
  element.style.setProperty("--theme-ink-mask", inkMask.reference);
  /**
   * Resolves and applies the target palette in one batched cssText write.
   * ~140 individual setProperty calls would each mark the clone's style tree;
   * a single cssText parses once. Runs inside prime, never on the click task.
   */
  let palette: Record<string, string> | null = null;
  let paletteCss = "";
  let primed = false;
  let primeFrame = 0;
  function applyLayerTheme(): void {
    palette ??= options.palette();
    if (!paletteCss) {
      for (const name of Object.keys(palette))
        if (!name.startsWith("--theme-ink-")) paletteCss += `${name}:${palette[name]};`;
    }
    const backdrop = palette["--stripe-bg"] ?? palette["--page"];
    const ink = palette["--ink"];
    // Palette vars on the overlay keep the backdrop/variables in the target
    // theme for any clone gap; the mask geometry vars are written separately.
    element.style.cssText +=
      (backdrop ? `background:${backdrop};` : "") + (ink ? `color:${ink};` : "") + paletteCss;
  }

  /**
   * Paints at the fixed viewport activation point while the mirrored document
   * scrolls independently underneath. Diagnostic attributes avoid custom-property
   * invalidation of the cloned subtree; mask geometry stays identical on scroll.
   */
  function paintMask(): void {
    element.dataset.themeInkX = `${options.origin.x}px`;
    element.dataset.themeInkY = `${options.origin.y}px`;
    inkMask.paint(currentRadius, options.origin.x, options.origin.y);
  }

  /**
   * Sets position/insets, theme class and color-scheme, then re-applies the
   * resolved palette as custom properties — also after a mirrored live
   * attribute wiped the clone body's host-owned chrome. Targeted writes
   * (not cssText) keep measure()'s mirrored margin/min-size intact.
   */
  function applyCloneBodyChrome(clone: HTMLElement): void {
    clone.style.position = "absolute";
    clone.style.left = "0px";
    clone.style.top = "0px";
    clone.style.right = `${Math.max(0, window.innerWidth - (docEl.clientWidth || window.innerWidth))}px`;
    clone.style.colorScheme = options.theme;
    if (palette?.["--ink"]) clone.style.color = palette["--ink"];
    if (palette)
      for (const name of Object.keys(palette))
        if (!name.startsWith("--theme-ink-")) clone.style.setProperty(name, palette[name]!);
    clone.classList.toggle("dark", options.theme === "dark");
    clone.setAttribute("data-theme", options.theme);
  }

  /** Restores the accumulated correction a `style` attribute mirror overwrote on a clone. */
  function reapplyCorrection(pair: CorrectedPair): void {
    if (pair.appliedX === 0 && pair.appliedY === 0) return;
    pair.clone.style.setProperty(
      "translate",
      `${pair.baseX + pair.appliedX}px ${pair.baseY + pair.appliedY}px`,
    );
  }

  /**
   * Mirrors live form/disclosure state onto clone properties — `cloneNode`
   * captures attributes, not user-mutated properties. File inputs are skipped
   * because their value setter throws; everything else is an inert visual echo.
   */
  function mirrorControlState(source: Element, clone: Element): void {
    if (source instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      if (source.type !== "file" && clone.type !== "file") clone.value = source.value;
      clone.checked = source.checked;
      clone.indeterminate = source.indeterminate;
    } else if (source instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
      clone.value = source.value;
    } else if (source instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      for (let index = 0; index < source.options.length; index += 1) {
        const option = clone.options[index];
        if (option) option.selected = source.options[index]!.selected;
      }
      clone.selectedIndex = source.selectedIndex;
    } else if (source instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
      clone.open = source.open;
    }
  }

  /** Copies valid canvas pixels without readback; zero-sized sources have no drawable bitmap. */
  function mirrorCanvasPixels(source: HTMLCanvasElement, clone: HTMLCanvasElement): void {
    clone.width = source.width;
    clone.height = source.height;
    if (source.width > 0 && source.height > 0) clone.getContext("2d")?.drawImage(source, 0, 0);
  }

  /**
   * Imports `document.body` into a registry-free document before sanitizing:
   * custom constructors cannot run during cloning. A detached pass drops
   * executable/metadata nodes and replaces autonomous elements with SPAN stubs
   * or base built-ins, strips media/frame fetches, and records
   * the live→clone node map, id/name namespace, and state-mirror targets.
   */
  function buildCloneBody(): HTMLElement | null {
    const source = document.body;
    if (!source) return null;
    const clone = cloneDocument.importNode(source, true) as HTMLElement;
    sourceToClone = new WeakMap();
    ids = new Map();
    names = new Map();
    const nextStubByClone = new WeakMap<Element, Element>();
    const controls: Array<[Element, Element]> = [];
    const canvases: Array<[HTMLCanvasElement, HTMLCanvasElement]> = [];
    sourceToClone.set(source, clone);

    const stack: Array<{ sourceNode: Node; cloneNode: Node }> = [
      { sourceNode: source, cloneNode: clone },
    ];
    while (stack.length > 0) {
      const { sourceNode, cloneNode } = stack.pop()!;
      const liveChildren = [...sourceNode.childNodes];
      const cloneChildren = [...cloneNode.childNodes];
      for (let index = 0; index < liveChildren.length; index += 1) {
        const live = liveChildren[index]!;
        const twin = cloneChildren[index]!;
        if (live.nodeType !== Node.ELEMENT_NODE) {
          sourceToClone.set(live, twin);
          continue;
        }
        const el = live as Element;
        let twinEl = twin as Element;
        const tag = el.tagName.toUpperCase();
        if (droppedTags[tag]) {
          twinEl.remove();
          continue;
        }
        if (el instanceof HTMLElement && el.tagName.includes("-")) {
          const stub = document.createElement("span");
          for (const attribute of [...twinEl.attributes])
            stub.setAttribute(attribute.name, attribute.value);
          stub.append(...twinEl.childNodes);
          twinEl.replaceWith(stub);
          twinEl = stub;
          nextStubByClone.set(stub, el);
        } else if (el instanceof HTMLElement && el.hasAttribute("is")) {
          // Customized built-ins degrade to their base tag: same paint, no upgrade.
          twinEl.removeAttribute("is");
        }
        sourceToClone.set(el, twinEl);

        const id = twinEl.getAttribute("id");
        if (id) ids.set(id, cloneIdPrefix + id);
        if (namedControlTags[tag]) {
          const controlName = twinEl.getAttribute("name");
          if (controlName) names.set(controlName, cloneIdPrefix + controlName);
        }
        if (tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED") {
          twinEl.removeAttribute("src");
          twinEl.removeAttribute("srcdoc");
          twinEl.removeAttribute("data");
        }
        if (tag === "VIDEO" || tag === "AUDIO") {
          twinEl.removeAttribute("autoplay");
          twinEl.removeAttribute("src");
          twinEl.setAttribute("preload", "none");
          for (const track of twinEl.querySelectorAll("source")) track.removeAttribute("src");
        }
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "DETAILS")
          controls.push([el, twinEl]);
        if (tag === "CANVAS") canvases.push([el as HTMLCanvasElement, twinEl as HTMLCanvasElement]);

        stack.push({ sourceNode: el, cloneNode: twinEl });
      }
    }
    stubByClone = nextStubByClone;
    rewriteIdNamespace(clone);
    mountMirroredRules();
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    applyCloneBodyChrome(clone);
    for (const [control, twin] of controls) mirrorControlState(control, twin);
    for (const [control, twin] of canvases) mirrorCanvasPixels(control, twin);
    return clone;
  }

  /** Pass 2 of cloning: rewrites every collected id/name reference inside the detached copy. */
  function rewriteIdNamespace(root: Element): void {
    for (const clone of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of [...clone.attributes]) {
        const value = attribute.value;
        if (!value) continue;
        const next = rewriteAttributeValue(clone, attribute.name, value, ids, names);
        if (next !== value) clone.setAttribute(attribute.name, next);
      }
    }
  }

  /**
   * Reads document bounds and the grow-only corner extent from rects alone,
   * converting the fixed viewport origin to document space only for coverage.
   * Mount needs the radius/visibility before prime's heavier style walk; the
   * measured body box also distinguishes resize changes from installation echoes.
   */
  function measureExtents(): void {
    const body = document.body;
    if (!body) return;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const docRect = docEl.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    // Cache the observed element's box so the observer's install echo can be
    // told apart from a real size change without another layout read.
    observedWidth = bodyRect.width;
    observedHeight = bodyRect.height;
    const clientW = docEl.clientWidth || window.innerWidth;
    const clientH = docEl.clientHeight || window.innerHeight;
    const left = Math.min(0, docRect.left + sx, bodyRect.left + sx);
    const top = Math.min(0, docRect.top + sy, bodyRect.top + sy);
    const right = Math.max(
      clientW,
      docRect.left + sx + Math.max(docEl.scrollWidth, clientW),
      bodyRect.left + sx + body.scrollWidth,
    );
    const bottom = Math.max(
      clientH,
      docRect.top + sy + Math.max(docEl.scrollHeight, clientH),
      bodyRect.top + sy + body.scrollHeight,
    );
    const originX = options.origin.x + sx;
    const originY = options.origin.y + sy;
    extentValue = Math.max(
      extentValue,
      Math.hypot(right - originX, bottom - originY),
      Math.hypot(left - originX, bottom - originY),
      Math.hypot(right - originX, top - originY),
      Math.hypot(left - originX, top - originY),
    );
  }

  /**
   * Recomputes scroll pairs and viewport-bound corrections in one batched
   * computed-style pass — runs inside prime, on structural mutations and on
   * resize, never per animation frame. `visit` keeps the per-element pairing
   * logic shared between prime-time builds and mid-wave rebuilds.
   */
  function measure(): void {
    const body = document.body;
    if (!body) return;
    const bodyStyle = getComputedStyle(body);
    const clientW = docEl.clientWidth || window.innerWidth;
    measureExtents();

    const nextScrollPairs = new Map<HTMLElement, ScrollPair>();
    const nextCorrected: CorrectedPair[] = [];
    const nextCorrectedByClone = new WeakMap<Element, CorrectedPair>();
    const stubDisplays: Array<[HTMLElement, string]> = [];

    /** Registers one live element's clone pairings from a single computed-style read. */
    const visit = (el: Element, style: CSSStyleDeclaration): void => {
      const tag = el.tagName.toUpperCase();
      if (droppedTags[tag]) return;
      const clone = sourceToClone.get(el);
      if (clone instanceof HTMLElement && stubByClone.get(clone) === el)
        stubDisplays.push([clone, style.display]);
      if (
        el !== body &&
        (style.position === "fixed" || style.position === "sticky") &&
        (clone instanceof HTMLElement || clone instanceof SVGElement)
      ) {
        const authored =
          style.translate && style.translate !== "none" ? style.translate.split(/\s+/) : [];
        const pair: CorrectedPair = {
          source: el,
          clone,
          baseX: Number.parseFloat(authored[0] ?? "0") || 0,
          baseY: Number.parseFloat(authored[1] ?? "0") || 0,
          appliedX: 0,
          appliedY: 0,
        };
        nextCorrected.push(pair);
        nextCorrectedByClone.set(clone, pair);
      }
      if (!(el instanceof HTMLElement)) return;
      const canScroll = /auto|scroll|hidden/.test(`${style.overflowX} ${style.overflowY}`);
      const scrollable =
        (canScroll &&
          (el.scrollHeight > el.clientHeight ||
            el.scrollWidth > el.clientWidth ||
            el.scrollTop !== 0 ||
            el.scrollLeft !== 0)) ||
        knownScrollers.has(el);
      if (!scrollable) return;
      if (clone instanceof HTMLElement && el !== docEl)
        nextScrollPairs.set(el, {
          source: el,
          clone,
          pendingX: 0,
          pendingY: 0,
        });
    };

    visit(body, bodyStyle);
    for (const el of body.querySelectorAll("*")) visit(el, getComputedStyle(el));

    scrollPairs = nextScrollPairs;
    correctedPairs = nextCorrected;
    correctedByClone = nextCorrectedByClone;
    for (const [stub, display] of stubDisplays) stub.style.display = display;
    if (cloneBody) {
      cloneBody.style.right = `${Math.max(0, window.innerWidth - clientW)}px`;
      cloneBody.style.margin = bodyStyle.margin;
      // The overlay scrollport must expose the live document's full scroll
      // range; the clone's own painted height can run shorter (e.g. styled
      // scrollbars, collapsed gaps), so it is floored to the real extents.
      cloneBody.style.minHeight = `${Math.max(docEl.scrollHeight, body.scrollHeight)}px`;
      cloneBody.style.minWidth = `${Math.max(docEl.scrollWidth, body.scrollWidth)}px`;
    }
  }

  /**
   * Mirrors live scroll state into the clone in three phases: batched reads
   * (window + every nested scrollport), writes (overlay scrollport position,
   * fixed-origin mask, mirrored scroll offsets), then a second batched read/write
   * for viewport-bound residuals. The overlay itself scrolls like the window, so
   * cloned fixed elements stay viewport-bound and sticky elements pin natively;
   * corrections only converge the rare transformed-root edge case. When the
   * window offset is unchanged — a pure nested scroll — only the cheap middle
   * phase runs.
   */
  function sync(): void {
    if (settled) return;
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const pair of scrollPairs.values()) {
      pair.pendingX = pair.source.scrollLeft;
      pair.pendingY = pair.source.scrollTop;
    }
    const moved = forceSync || sx !== lastSX || sy !== lastSY;
    // The overlay IS the cloned document's scrollport: same-value scroll
    // assignments fire no scroll events, and the target check on the live
    // capture listener rejects clone-side feedback.
    if (moved) {
      element.scrollLeft = sx;
      element.scrollTop = sy;
    }
    paintMask();
    // Unconditional writes: assigning the current value fires no scroll event,
    // and a non-scrollable clone simply clamps — no clone-side read needed.
    for (const pair of scrollPairs.values()) {
      pair.clone.scrollLeft = pair.pendingX;
      pair.clone.scrollTop = pair.pendingY;
    }
    if (!moved) return;
    lastSX = sx;
    lastSY = sy;
    forceSync = false;
    if (correctedPairs.length === 0) return;
    const deltas = correctedPairs.map((pair) => ({
      live: pair.source.getBoundingClientRect(),
      clone: pair.clone.getBoundingClientRect(),
    }));
    correctedPairs.forEach((pair, index) => {
      const { live, clone } = deltas[index]!;
      const dx = live.left - clone.left;
      const dy = live.top - clone.top;
      if (dx === 0 && dy === 0 && pair.appliedX === 0 && pair.appliedY === 0) return;
      pair.appliedX += dx;
      pair.appliedY += dy;
      reapplyCorrection(pair);
    });
  }

  /** Paints expanding or withdrawing coverage at the fixed control origin; each starting endpoint hides its target copy. */
  function paint(radius: number): void {
    if (settled) return;
    currentRadius = Math.max(0, radius);
    element.style.visibility = (inverse ? currentRadius < extentValue + 24 : currentRadius > 0)
      ? "visible"
      : "hidden";
    element.dataset.themeInkRadius = `${currentRadius}`;
    paintMask();
  }

  /**
   * Rebuilds the clone after structural DOM changes; palette, mask and
   * radius are untouched. Before prime there is no clone yet — the pending
   * prime frame builds against the newest DOM instead. Callers coalesce
   * through `scheduleRebuild` so several mutation batches in one frame pay
   * for a single re-clone + measure pass.
   */
  function rebuild(): void {
    rebuildFrame = 0;
    if (settled || !primed) return;
    const next = buildCloneBody();
    if (!next) return;
    cloneBody = next;
    element.replaceChildren(inkMask.element, cloneBody);
    measure();
    forceSync = true;
    sync();
  }

  /**
   * Schedules one rebuild for the next frame. Structural mutations inside a
   * frame (and across queued mutation batches) collapse into a single pass,
   * and running inside rAF keeps the fresh clone's geometry ahead of the
   * same paint instead of extending the mutation task.
   */
  function scheduleRebuild(): void {
    if (rebuildFrame || settled) return;
    rebuildFrame = requestAnimationFrame(rebuild);
  }

  /**
   * Re-applies host-owned state after an attribute mirror: the clone body
   * keeps its target-theme class/palette/chrome, viewport-bound clones get
   * their accumulated translate back, stubs keep the live display mode, and
   * checked/value/open attribute flips re-mirror the matching property.
   */
  function fixMirroredClone(source: Element, clone: Element, name: string): void {
    if (cloneBody && clone === cloneBody) {
      if (name === "style" || name === "class" || name === "data-theme")
        applyCloneBodyChrome(cloneBody);
      else {
        cloneBody.classList.toggle("dark", options.theme === "dark");
        cloneBody.setAttribute("data-theme", options.theme);
      }
    }
    if (name === "style") {
      const corrected = correctedByClone.get(clone);
      if (corrected) reapplyCorrection(corrected);
      const stubSource = stubByClone.get(clone);
      if (stubSource && clone instanceof HTMLElement)
        clone.style.display = getComputedStyle(stubSource).display;
    }
    if (
      name === "checked" ||
      name === "value" ||
      name === "open" ||
      name === "selected" ||
      name === "type"
    )
      mirrorControlState(source, clone);
  }

  /**
   * Applies one live attribute mutation to its mapped clone, running the
   * value through the same namespace rewrite used at build so prefixed ids
   * and control names stay isolated. Unmapped targets (dropped subtrees)
   * are ignored by construction.
   */
  function mirrorAttribute(record: MutationRecord): void {
    const source = record.target;
    if (!(source instanceof Element)) return;
    const clone = sourceToClone.get(source);
    if (!(clone instanceof Element)) return;
    const name = record.attributeName;
    if (!name) return;
    const value = source.getAttribute(name);
    // A live id/name mutation changes what the mirrored selector rules can
    // match, so the mirror sheets regenerate on this batch.
    if (name === "id" || name === "name") mirroredRulesStale = true;
    if (value === null) clone.removeAttribute(name);
    else {
      clone.setAttribute(name, rewriteAttributeValue(clone, name, value, ids, names));
      // Keep the id/name namespace maps current so later references rewrite.
      if (name === "id") ids.set(value, cloneIdPrefix + value);
      if (name === "name" && namedControlTags[clone.tagName.toUpperCase()])
        names.set(value, cloneIdPrefix + value);
    }
    fixMirroredClone(source, clone, name);
  }

  /**
   * Mirrors mutations incrementally: attribute/characterData records patch
   * mapped clone nodes (so per-frame inline-style or text churn never
   * triggers a rebuild), while childList records request one coalesced
   * rebuild per frame. Records whose only moved nodes are mirror `<style>`
   * elements are skipped so mounting/removing them can never re-enter;
   * overlay mutations can't re-enter at all — it lives outside the observed
   * body subtree.
   */
  const observer = new MutationObserver((records) => {
    if (settled) return;
    let structural = false;
    for (const record of records) {
      // Rebuild writes inside the overlay only re-enter when there is no real
      // body to observe; contain them so mirroring can never loop.
      if (element.contains(record.target)) continue;
      if (record.type === "childList") {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (!(node instanceof Element) || !node.hasAttribute(mirrorStyleMarker)) {
            structural = true;
            break;
          }
        }
        continue;
      }
      if (record.type === "characterData") {
        const clone = sourceToClone.get(record.target);
        if (clone && clone.nodeType === record.target.nodeType)
          clone.nodeValue = record.target.nodeValue;
        continue;
      }
      mirrorAttribute(record);
    }
    if (structural) scheduleRebuild();
    else if (mirroredRulesStale && cloneBody) mountMirroredRules();
  });

  /**
   * Mirrors window + nested scrolling synchronously. The event target is the
   * scroller itself, so an unmeasured scrollport registers lazily; clone
   * scroll feedback is ignored because the overlay sits outside the body.
   */
  function onScroll(event: Event): void {
    const target = event.target;
    if (target instanceof Node && element.contains(target)) return;
    if (target instanceof HTMLElement && target !== docEl) {
      const clone = sourceToClone.get(target);
      if (clone instanceof HTMLElement && !scrollPairs.has(target)) {
        knownScrollers.add(target);
        scrollPairs.set(target, {
          source: target,
          clone,
          pendingX: 0,
          pendingY: 0,
        });
      }
    }
    sync();
  }

  /** Refreshes geometry after layout changes — extent and corrections update without resetting the mask. */
  function onResize(): void {
    if (settled) return;
    if (primed) measure();
    else measureExtents();
    forceSync = true;
    sync();
  }

  /** Mirrors property-only control changes (typing, toggling) that fire events instead of mutating attributes. */
  function onFieldEvent(event: Event): void {
    const source = event.target;
    if (!(source instanceof Element) || element.contains(source)) return;
    const clone = sourceToClone.get(source);
    if (clone instanceof Element) mirrorControlState(source, clone);
  }

  // Optional in engines without ResizeObserver; window resize still covers it.
  // The spec's install delivery fires once with the current size — skipped
  // only while it echoes the size measureExtents already captured, so a real
  // change landing between mount and that delivery still re-measures.
  let resizeEcho = true;
  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          if (resizeEcho) {
            resizeEcho = false;
            const box = entries[0]?.borderBoxSize?.[0];
            const width = box ? box.inlineSize : entries[0]?.contentRect.width;
            const height = box ? box.blockSize : entries[0]?.contentRect.height;
            if (width === observedWidth && height === observedHeight) return;
          }
          onResize();
        })
      : null;

  /**
   * Tears down the layer and every listener/observer; live paint is never
   * written. Safe before listeners exist — it is the constructor's failure
   * path for orphan cleanup as well as the public destroy.
   */
  function destroy(): void {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(primeFrame);
    cancelAnimationFrame(rebuildFrame);
    observer.disconnect();
    resizeObserver?.disconnect();
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("input", onFieldEvent, true);
    document.removeEventListener("change", onFieldEvent, true);
    document.removeEventListener("toggle", onFieldEvent, true);
    while (mirrorStyles.length) mirrorStyles.pop()!.remove();
    element.remove();
  }

  /**
   * First-frame prime: resolve the target palette (its root class swap costs
   * a full live recalc), apply it in one cssText batch, then build and
   * measure the clone. Runs inside rAF so the click task stays under one
   * frame and the wave's first painted frame is already scheduled.
   */
  function prime(): void {
    primeFrame = 0;
    if (settled) return;
    primed = true;
    applyLayerTheme();
    cloneBody = buildCloneBody();
    if (cloneBody) element.appendChild(cloneBody);
    measure();
    forceSync = true;
    sync();
  }

  try {
    element.appendChild(inkMask.element);
    docEl.appendChild(element);
    measureExtents();
    forceSync = true;
    sync();
    paint(0);
    observer.observe(document.body ?? docEl, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    resizeObserver?.observe(document.body ?? docEl);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("input", onFieldEvent, true);
    document.addEventListener("change", onFieldEvent, true);
    document.addEventListener("toggle", onFieldEvent, true);
    primeFrame = requestAnimationFrame(prime);
  } catch (error) {
    // A half-built layer must not linger as a hidden orphan overlay.
    destroy();
    throw error;
  }

  return {
    element,
    /** Grow-only radius covering the root document's farthest painted corner. */
    get extent() {
      return extentValue;
    },
    sync,
    paint,
    destroy,
  };
}
