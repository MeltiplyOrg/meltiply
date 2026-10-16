// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import "@testing-library/jest-dom/vitest";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";
import { startWorkspaceSlotTransition } from "@/components/layout/workspace-slot-transition";
import { startThemeReveal } from "@meltiply/ui/theme-transition";
const styles = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

const originalAnimate = HTMLElement.prototype.animate;
let finishAnimations: Array<() => void> = [];
let cancelAnimations: Array<Mock> = [];

/** Creates a measurable slot; collapsed slots retain an eight-pixel route anchor. */
function createSlot(id: string, collapsed = false): HTMLDivElement {
  const slot = document.createElement("div");
  slot.dataset.workspaceTransitionSlot = id;
  if (collapsed) slot.dataset.workspaceTransitionCollapsed = "true";
  slot.getBoundingClientRect = () => new DOMRect(480, 48, collapsed ? 8 : 160, 32);
  if (!collapsed) slot.textContent = id;
  return slot;
}

beforeEach(() => {
  finishAnimations = [];
  cancelAnimations = [];
  const sheet = document.createElement("style");
  sheet.textContent = styles;
  document.body.append(sheet);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  HTMLElement.prototype.animate = vi.fn(() => {
    const finished = new Promise<void>((resolve) => finishAnimations.push(resolve));
    const cancel = vi.fn();
    cancelAnimations.push(cancel);
    return { cancel, finished } as unknown as Animation;
  });
});

afterEach(() => {
  document.documentElement.removeAttribute("data-low-motion");
  startWorkspaceSlotTransition(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  HTMLElement.prototype.animate = originalAnimate;
});

describe("startWorkspaceSlotTransition", () => {
  /** Deferred commits must not paint both the live source and its snapshot. */
  it("hides the mounted source atomically and restores it on cancellation", () => {
    const root = document.createElement("main");
    const source = createSlot("date");
    root.append(source);
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    expect(source).not.toBeVisible();
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toHaveTextContent(
      "date",
    );
    startWorkspaceSlotTransition(null);
    expect(source).toBeVisible();
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
  });

  /** Ink must capture visible controls even when a route handoff is still waiting for its destination. */
  it("restores held controls synchronously before an ink reveal captures the document", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const root = document.createElement("main");
    const source = createSlot("date");
    root.append(source);
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    expect(source).not.toBeVisible();
    const reveal = startThemeReveal({
      fromTheme: "light",
      toTheme: "dark",
      origin: { x: 480, y: 48 },
      lowMotion: false,
      applyTheme: () => document.documentElement.classList.add("dark"),
      restoreTheme: () => document.documentElement.classList.remove("dark"),
    });
    try {
      expect(source).toBeVisible();
    } finally {
      reveal.skip();
    }
  });

  /** Motion may restore opacity during mount; it must not expose live destinations. */
  it("keeps date and right-side destinations hidden until their snapshots finish", async () => {
    const root = document.createElement("main");
    root.append(createSlot("date", true));
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    const date = createSlot("date");
    const sort = createSlot("sort");
    const view = createSlot("view-mode");
    root.replaceChildren(date, sort, view);
    await waitFor(() => expect(date).not.toBeVisible());
    for (const target of [date, sort, view]) {
      target.style.opacity = "1";
      expect(target).not.toBeVisible();
    }
    const layer = document.querySelector("[data-workspace-slot-transition-layer]");
    expect(layer).toHaveTextContent("datesortview-mode");
    for (const finish of finishAnimations) finish();
    await waitFor(() => {
      for (const target of [date, sort, view]) expect(target).toBeVisible();
      expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
    });
  });

  /** Source-only controls survive unmount until their exit completes. */
  it("retains exiting controls while the destination is collapsed or absent", async () => {
    const root = document.createElement("main");
    root.append(createSlot("date"), createSlot("sort"));
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    root.replaceChildren(createSlot("date", true));
    await waitFor(() => expect(finishAnimations).toHaveLength(2));
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toHaveTextContent(
      "datesort",
    );
    for (const finish of finishAnimations) finish();
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull(),
    );
  });

  /** A cancelled animation's completion must not expose the next route mid-handoff. */
  it("keeps a replacement transition hidden when the previous animations settle", async () => {
    const root = document.createElement("main");
    root.append(createSlot("date", true));
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    const firstTarget = createSlot("date");
    root.replaceChildren(firstTarget);
    await waitFor(() => expect(firstTarget).not.toBeVisible());
    const previousFinishes = [...finishAnimations];

    startWorkspaceSlotTransition(root);
    const nextTarget = createSlot("date");
    root.replaceChildren(nextTarget);
    await waitFor(() => expect(nextTarget).not.toBeVisible());
    for (const finish of previousFinishes) finish();
    await Promise.resolve();
    expect(nextTarget).not.toBeVisible();
    expect(document.querySelectorAll("[data-workspace-slot-transition-layer]")).toHaveLength(1);

    for (const finish of finishAnimations) finish();
    await waitFor(() => {
      expect(nextTarget).toBeVisible();
      expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
    });
  });

  /** An abandoned navigation must release hidden controls without another navigation. */
  it("restores original visibility when no destination commits", () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement("main");
      const source = createSlot("date");
      source.style.setProperty("visibility", "visible", "important");
      root.append(source);
      document.body.append(root);
      startWorkspaceSlotTransition(root);
      expect(source).not.toBeVisible();
      vi.runAllTimers();
      expect(source).toBeVisible();
      expect(source.style.getPropertyPriority("visibility")).toBe("important");
      expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /** Enabling low motion mid-wait must free the source before a destination commits. */
  it("frees the held source immediately when low motion turns on before commit", async () => {
    const root = document.createElement("main");
    const source = createSlot("date");
    root.append(source);
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    expect(source).not.toBeVisible();

    document.documentElement.setAttribute("data-low-motion", "");
    await waitFor(() => expect(source).toBeVisible());
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();

    // A late destination commit must not re-hide or animate anything.
    document.documentElement.removeAttribute("data-low-motion");
    const destination = createSlot("date");
    root.replaceChildren(destination);
    await Promise.resolve();
    expect(destination).toBeVisible();
    expect(cancelAnimations).toHaveLength(0);
  });

  /** Enabling low motion mid-handoff must cancel WAAPI and reveal live controls. */
  it("cancels in-flight animations and reveals the destination when low motion turns on", async () => {
    const root = document.createElement("main");
    root.append(createSlot("date", true));
    document.body.append(root);
    startWorkspaceSlotTransition(root);
    const destination = createSlot("date");
    root.replaceChildren(destination);
    await waitFor(() => expect(destination).not.toBeVisible());
    expect(cancelAnimations).toHaveLength(1);

    document.documentElement.setAttribute("data-low-motion", "");
    await waitFor(() => expect(destination).toBeVisible());
    expect(cancelAnimations[0]).toHaveBeenCalled();
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
  });

  /** A marker set in the same task as the commit must not start animations. */
  it("skips the handoff when low motion turns on in the same task as the commit", async () => {
    const root = document.createElement("main");
    const source = createSlot("date");
    root.append(source);
    document.body.append(root);
    startWorkspaceSlotTransition(root);

    const destination = createSlot("date");
    root.append(destination);
    document.documentElement.setAttribute("data-low-motion", "");
    await waitFor(() => {
      expect(source).toBeVisible();
      expect(destination).toBeVisible();
    });
    expect(cancelAnimations).toHaveLength(0);
    expect(document.querySelector("[data-workspace-slot-transition-layer]")).toBeNull();
  });
});
