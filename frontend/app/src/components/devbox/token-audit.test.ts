// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  auditTokenColors,
  clearTokenHighlights,
  collectTokenColors,
  highlightTokenViolations,
  type TokenColorMap,
} from "./token-audit";

const emptyTokens: TokenColorMap = { byColor: new Map(), resolved: 0 };

let elements: Element[] = [];
let styles: HTMLStyleElement[] = [];

/** Appends an element to the audit root and returns it. */
function append<T extends Element>(element: T): T {
  document.body.appendChild(element);
  elements.push(element);
  return element;
}

/**
 * Adds a stylesheet rule. Tests use CSS rather than inline paint so the audit
 * sees the same cascade shape as utilities compiled by Tailwind.
 */
function appendStyle(css: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  styles.push(style);
}

afterEach(() => {
  for (const element of elements) element.remove();
  for (const style of styles) style.remove();
  elements = [];
  styles = [];
  clearTokenHighlights();
  document.documentElement.removeAttribute("style");
});

describe("token audit", () => {
  it("matches canonical tokens and resolves alias/tint values to painted colors", () => {
    const root = document.documentElement;
    root.style.setProperty("--page", "#fbfaf8");
    root.style.setProperty("--background", "var(--page)");
    root.style.setProperty("--accent", "#4b5bd6");
    root.style.setProperty("--accent-tint", "color-mix(in srgb, #4b5bd6 10%, transparent)");

    const compliant = append(document.createElement("div"));
    compliant.id = "compliant-token";
    appendStyle(`
      #compliant-token {
        color: #4b5bd6;
        background-color: color-mix(in srgb, #4b5bd6 10%, transparent);
      }
    `);

    const tokens = collectTokenColors();
    expect(tokens.byColor.get("rgb(75, 91, 214)")).toContain("--accent");
    expect(tokens.byColor.get("rgb(251, 250, 248)")).toEqual(
      expect.arrayContaining(["--page", "--background"]),
    );

    expect(auditTokenColors(tokens)).toEqual([]);
  });

  it("ignores opacity modifiers, active variants, and side-specific border token utilities", () => {
    const styled = append(document.createElement("button"));
    styled.id = "styled-utility";
    styled.className =
      "data-[state=active]:bg-accent/10 data-[state=active]:text-ink-2 border-x-line/50 bg-accent-tint/5";
    styled.setAttribute("data-state", "active");
    appendStyle(`
      #styled-utility {
        color: rgb(87, 84, 78);
        background-color: rgba(75, 91, 214, 0.05);
        border-color: rgba(233, 231, 226, 0.5);
      }
    `);

    expect(auditTokenColors(emptyTokens)).toEqual([]);
  });

  it("does not let an inactive variant excuse a raw color", () => {
    const raw = append(document.createElement("button"));
    raw.id = "inactive-variant";
    raw.className = "hover:bg-accent/10";
    appendStyle("#inactive-variant { background-color: rgb(255, 0, 0); }");

    const violations = auditTokenColors(emptyTokens);
    expect(violations).toHaveLength(1);
    expect(violations[0].element).toBe(raw);
  });

  it("recognizes a responsive token utility when its breakpoint is active", () => {
    const previous = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    try {
      const styled = append(document.createElement("div"));
      styled.id = "responsive-utility";
      styled.className = "md:border-line/50 text-ink-2";
      appendStyle("#responsive-utility { border-color: rgba(233, 231, 226, 0.5); }");

      expect(auditTokenColors(emptyTokens)).toEqual([]);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previous });
    }
  });

  it("does not let a token utility excuse inline paint", () => {
    const raw = append(document.createElement("div"));
    raw.id = "inline-raw";
    raw.className = "bg-surface";
    raw.setAttribute("style", "background-color: rgb(255, 0, 0)");

    const violations = auditTokenColors(emptyTokens);
    expect(violations).toHaveLength(1);
    expect(violations[0].element).toBe(raw);
  });

  it("does not let a border token utility excuse an inline side color", () => {
    const raw = append(document.createElement("div"));
    raw.id = "inline-border-raw";
    raw.className = "border-line text-ink-2";
    raw.setAttribute("style", "border-left-color: rgb(255, 0, 0)");

    const violations = auditTokenColors(emptyTokens);
    expect(violations).toHaveLength(1);
    expect(violations[0].element).toBe(raw);
    expect(violations[0].reports.map((report) => report.property)).toContain("borderColor");
  });

  it("reports raw colors that carry no token value or token utility", () => {
    const raw = append(document.createElement("div"));
    raw.id = "raw-color";
    appendStyle("#raw-color { background-color: rgb(255, 0, 0); }");

    const violations = auditTokenColors(emptyTokens);
    expect(violations).toHaveLength(1);
    expect(violations[0].element).toBe(raw);
    expect(violations[0].reports.map((report) => report.property)).toContain("backgroundColor");
  });

  it("removes marks and the injected stylesheet when highlights are cleared", () => {
    const raw = append(document.createElement("div"));
    raw.id = "highlight-raw";
    appendStyle("#highlight-raw { background-color: rgb(255, 0, 0); }");
    const violations = auditTokenColors(emptyTokens);

    highlightTokenViolations(violations);
    expect(raw).toHaveAttribute("data-devbox-token-violation");
    expect(document.getElementById("devbox-token-violation-style")).not.toBeNull();

    clearTokenHighlights();
    expect(raw).not.toHaveAttribute("data-devbox-token-violation");
    expect(document.getElementById("devbox-token-violation-style")).toBeNull();
  });
});
