// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const lenisMock = vi.hoisted(() => ({
  destroy: vi.fn(),
  instance: undefined as { destroy: () => void } | undefined,
  options: undefined as unknown,
}));

vi.mock("lenis", () => ({
  // `function` (not an arrow) so `new Lenis(...)` constructs through the v5
  // spy's Reflect.construct path: the returned instance object wins over
  // `this`, and construction calls record into mock.calls for
  // toHaveBeenCalledOnce just like ordinary calls.
  default: vi.fn(function LenisMock(options: unknown) {
    lenisMock.instance = { destroy: lenisMock.destroy };
    lenisMock.options = options;
    return lenisMock.instance;
  }),
}));

import Lenis from "lenis";

import { createSmoothScroll } from "@/components/layout/smooth-scroll";

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  lenisMock.instance = undefined;
  lenisMock.options = undefined;
});

describe("createSmoothScroll", () => {
  it("initializes document scrolling and preserves nested scroll containers", () => {
    const destroy = createSmoothScroll();

    expect(Lenis).toHaveBeenCalledOnce();
    const options = lenisMock.options as {
      allowNestedScroll: boolean;
      anchors: boolean;
      autoRaf: boolean;
      prevent: (node: HTMLElement) => boolean;
    };
    expect(options).toMatchObject({
      allowNestedScroll: false,
      anchors: true,
      autoRaf: true,
    });

    const nestedScroller = document.createElement("div");
    nestedScroller.dataset.lenisPrevent = "";
    const nestedChild = document.createElement("button");
    nestedScroller.append(nestedChild);
    document.body.append(nestedScroller);

    expect(options.prevent(nestedChild)).toBe(true);
    expect(options.prevent(document.body)).toBe(false);

    destroy();
  });

  it("destroys Lenis when the lifecycle cleanup runs", () => {
    const destroy = createSmoothScroll();

    destroy();

    expect(lenisMock.destroy).toHaveBeenCalledOnce();
  });
});
