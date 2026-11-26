// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { Button, buttonVariants } from "@meltiply/ui/button";

const SCOPE_CLASS = "icon-scope";

function scopeSvgRules(css: string): string {
  return css.replace(/([^{}@]+)\{/g, (rule, selector: string) => {
    const rebound = selector
      .split(",")
      .map((part) => {
        const descendant = part.indexOf(" svg");
        return descendant === -1 ? part : `.${SCOPE_CLASS}${part.slice(descendant)}`;
      })
      .join(",");
    return `${rebound}{`;
  });
}

beforeAll(async () => {
  const candidates = [
    ...buttonVariants().split(/\s+/).filter(Boolean),
    ...buttonVariants({ size: "icon" }).split(/\s+/).filter(Boolean),
    "size-3",
    "size-3.5",
    "size-5",
    "size-6",
    "size-7",
    "size-8",
    "size-full",
  ];
  const compiler = await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;", {
    base: process.cwd(),
  });
  const style = document.createElement("style");
  style.textContent = scopeSvgRules(compiler.build(candidates));
  document.head.appendChild(style);
});

function renderIcon(svgClassName?: string): SVGSVGElement {
  const { container } = render(
    <Button className={SCOPE_CLASS}>
      <svg className={svgClassName} data-testid="icon" />
    </Button>,
  );
  const icon = container.querySelector("svg");
  if (!icon) throw new Error("expected Button to render the svg icon");
  return icon;
}

describe("Button icon sizing", () => {
  it("defaults unsized icons to the standard 16px utility", () => {
    const icon = renderIcon();
    const style = window.getComputedStyle(icon);
    expect(style.width).toBe("calc(var(--spacing) * 4)");
    expect(style.height).toBe("calc(var(--spacing) * 4)");
  });

  it.each([
    ["size-3", "calc(var(--spacing) * 3)"],
    ["size-3.5", "calc(var(--spacing) * 3.5)"],
    ["size-full", "100%"],
  ] as const)("keeps authored %s icons at their exact dimensions", (sizeClass, expected) => {
    const icon = renderIcon(sizeClass);
    const style = window.getComputedStyle(icon);
    expect(style.width).toBe(expected);
    expect(style.height).toBe(expected);
  });

  it("keeps icons non-interactive and shrink-proof", () => {
    const style = window.getComputedStyle(renderIcon());
    expect(style.pointerEvents).toBe("none");
    expect(style.flexShrink).toBe("0");
  });
});

describe("Button icon preset with caller square geometry", () => {
  it.each([
    ["size-5", "calc(var(--spacing) * 5)"],
    ["size-6", "calc(var(--spacing) * 6)"],
    ["size-7", "calc(var(--spacing) * 7)"],
    ["size-8", "calc(var(--spacing) * 8)"],
  ] as const)(
    "keeps a caller-authored %s square at its exact dimensions",
    (sizeClass, expected) => {
      const { container } = render(
        <Button size="icon" className={sizeClass}>
          <svg data-testid="icon" />
        </Button>,
      );
      const button = container.querySelector("button");
      if (!button) throw new Error("expected Button to render a button element");
      const style = window.getComputedStyle(button);
      expect(style.width).toBe(expected);
      expect(style.height).toBe(expected);
      expect(style.padding).toBe("0");
    },
  );
});
