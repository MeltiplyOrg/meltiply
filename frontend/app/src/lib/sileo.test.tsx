// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Sileo, Toaster } from "@meltiply/ui/sileo";
import { toast } from "@meltiply/ui/toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => vi.advanceTimersByTime(15000));
  cleanup();
  vi.useRealTimers();
});

describe("sileo toast store", () => {
  it("keeps a same-id replacement visible past the exiting toast's removal delay", () => {
    render(<Toaster />);
    act(() => toast("First", { description: "First action completed" }));
    fireEvent.click(screen.getByText("First"));
    act(() => vi.advanceTimersByTime(120));
    act(() => toast("Replacement", { description: "Latest action completed" }));
    expect(screen.getByText("Replacement")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Replacement")).toBeInTheDocument();
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });

  it("morphs repeated same-id refreshes into a single toast that commits only the latest payload", () => {
    render(<Toaster />);
    act(() => toast("Alpha", { description: "first body" }));
    act(() => vi.advanceTimersByTime(300));
    const node = () => document.querySelector("[data-sileo-toast]");
    expect(node()).toHaveAttribute("data-expanded", "true");

    act(() => toast("Beta", { description: "stale body" }));
    expect(node()).toHaveAttribute("data-expanded", "false");
    act(() => toast("Gamma", { description: "third body" }));
    act(() => vi.advanceTimersByTime(400));

    expect(document.querySelectorAll("[data-sileo-toast]")).toHaveLength(1);
    expect(node()).toHaveAttribute("data-expanded", "true");
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    expect(screen.getByText("third body")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.queryByText("stale body")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("finishes collapsing a pinned prompt before expanding its confirmation", () => {
    const view = render(
      <Sileo
        id="consent"
        pinned
        title="Prompt"
        description="Choices"
        refreshKey="prompt"
        autoExpandDelayMs={0}
      />,
    );
    view.rerender(
      <Sileo
        id="consent"
        title="Confirmation"
        description="Saved"
        refreshKey="saved"
        autoExpandDelayMs={0}
      />,
    );
    act(() => vi.advanceTimersByTime(16));
    expect(document.querySelector("[data-sileo-toast]")).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(document.querySelector("[data-sileo-toast]")).toHaveAttribute("data-expanded", "true");
  });
});
