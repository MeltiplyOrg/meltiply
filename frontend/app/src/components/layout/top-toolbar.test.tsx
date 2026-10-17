// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TopToolbar,
  TopToolbarLabel,
  TopToolbarReset,
  TopToolbarSearch,
  TopToolbarButton,
} from "@/components/layout/top-toolbar";
import { I18nProvider } from "@/lib/i18n";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.lang = "en";
});

describe("TopToolbar", () => {
  /**
   * Exercises that TopToolbar renders content directly without wrapping children
   * in route-fading opacity layers.
   */
  it("renders toolbar children without fading wrappers and maintains locked 54px height", () => {
    const { container } = render(
      <TopToolbar>
        <span data-testid="test-content">Toolbar items</span>
      </TopToolbar>,
    );

    const item = screen.getByTestId("test-content");
    expect(item).toBeInTheDocument();
    expect(item).toBeVisible();

    const toolbar = container.firstChild as HTMLElement;
    expect(toolbar).toHaveClass("h-[3.375rem]", "min-h-[3.375rem]");
  });
});
describe("TopToolbarButton", () => {
  /**
   * Exercises that TopToolbarButton renders with locked sizing, hairline shadow,
   * proper label, and elevation styles when active.
   */
  it("renders with standardized fixed dimensions and morphing label", () => {
    const { rerender } = render(
      <TopToolbarButton label="All platforms" width="w-36" isActive={false} />,
    );

    const button = screen.getByRole("button", { name: "All platforms" });
    expect(button).toBeInTheDocument();
    expect(button).toBeVisible();
    expect(button).toHaveClass("w-36", "h-8", "shadow-hairline");

    rerender(<TopToolbarButton label="Instagram" width="w-36" isActive={true} />);
    expect(button).toHaveClass("w-36", "h-8", "shadow-sm", "border-line-strong");
    expect(screen.getByText("Instagram")).toBeInTheDocument();
  });
});

describe("TopToolbarLabel", () => {
  /**
   * Exercises that a changing label keeps the outgoing span mounted for its exit
   * animation while removing it from the accessibility tree, so a trigger whose
   * accessible name comes from its content only ever resolves to the incoming
   * label instead of a transient concatenation of outgoing and incoming text.
   */
  it("hides the exiting label so the trigger's accessible name stays on the new label", () => {
    const { rerender } = render(
      <button type="button">
        <TopToolbarLabel label="All platforms" />
      </button>,
    );

    rerender(
      <button type="button">
        <TopToolbarLabel label="Instagram" />
      </button>,
    );

    // The outgoing label is still mounted mid-exit but gated from assistive
    // technology, so it cannot leak into the trigger's accessible name.
    const exiting = screen.getByText("All platforms");
    expect(exiting).toHaveAttribute("aria-hidden", "true");

    // The incoming label alone supplies the trigger's accessible name.
    expect(screen.getByRole("button", { name: "Instagram" })).toBeInTheDocument();
    expect(screen.getByText("Instagram")).not.toHaveAttribute("aria-hidden", "true");
  });
});

describe("TopToolbarSearch", () => {
  /**
   * Exercises that the populated search field's clear trigger exposes an accessible
   * name resolved from the active locale rather than a hardcoded English literal.
   */
  it("localizes the clear search button accessible name to the active language", () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    window.localStorage.setItem("meltiply.language", "es");

    render(
      <I18nProvider>
        <TopToolbarSearch value="meltiply" onChange={vi.fn()} placeholder="Search posts" />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "Limpiar búsqueda" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });
});

describe("TopToolbarReset", () => {
  /**
   * Exercises that TopToolbarReset pops out when hasActiveFilters is true
   * and dispatches the onReset callback when clicked.
   */
  it("renders the reset trigger when active filters exist and fires onReset", async () => {
    const onReset = vi.fn();
    const { rerender } = render(<TopToolbarReset hasActiveFilters={false} onReset={onReset} />);

    expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();

    rerender(<TopToolbarReset hasActiveFilters={true} onReset={onReset} />);

    const button = screen.getByRole("button", { name: /reset/i });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onReset).toHaveBeenCalledOnce();

    rerender(<TopToolbarReset hasActiveFilters={false} onReset={onReset} />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
    });
  });

  /**
   * Exercises that TopToolbarReset is immediately visible on initial render with active filters.
   */
  it("is visible when initially mounted with active filters", () => {
    const onReset = vi.fn();
    render(<TopToolbarReset hasActiveFilters={true} onReset={onReset} />);

    const button = screen.getByRole("button", { name: /reset/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeVisible();
  });
});
