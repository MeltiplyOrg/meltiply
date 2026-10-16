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
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
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

describe("WorkspaceSurface", () => {
  /**
   * Exercises that WorkspaceSurface exposes spaced accessible text for the animated
   * heading while hiding the word-level motion spans from the accessibility tree,
   * and keeps children visible on initial render.
   */
  it("announces spaced heading text while word spans stay aria-hidden and children visible", () => {
    render(
      <WorkspaceSurface title="Scheduled Posts" description="Review scheduled content">
        <div data-testid="workspace-body">Main workspace canvas</div>
      </WorkspaceSurface>,
    );

    // The heading's accessible name comes from a full-text copy, so assistive
    // technology announces natural word spacing instead of one concatenated token.
    expect(screen.getByRole("heading", { name: "Scheduled Posts" })).toBeInTheDocument();

    // The description likewise exposes its full text to assistive technology
    // rather than only the animated word fragments.
    const description = screen.getByText("Review scheduled content");
    expect(description.closest("[aria-hidden]")).not.toHaveAttribute("aria-hidden", "true");

    // Animated word spans stay in the visual DOM but are hidden from assistive technology.
    expect(screen.getByText("Scheduled")).toHaveAttribute("aria-hidden", "true");

    // Children are immediately visible without opacity: 0 suppression
    const body = screen.getByTestId("workspace-body");
    expect(body).toBeInTheDocument();
    expect(body).toBeVisible();
  });

  /**
   * Exercises that while an outgoing title/description is still animating out,
   * its accessible copies drop out of the accessibility tree so the header
   * exposes exactly one accessible name mid-crossfade.
   */
  it("keeps a single accessible name while the outgoing title and description exit", () => {
    const { rerender } = render(
      <WorkspaceSurface title="Posts" description="Manage posts">
        <div>body</div>
      </WorkspaceSurface>,
    );

    rerender(
      <WorkspaceSurface title="Channels Board" description="Manage channels">
        <div>body</div>
      </WorkspaceSurface>,
    );

    // The exiting copies stay mounted for their exit animation but are gated from
    // assistive technology, so the heading name resolves to the incoming title only.
    expect(screen.getByRole("heading", { name: "Channels Board" })).toBeInTheDocument();
    for (const node of screen.getAllByText("Posts")) {
      expect(node.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    }
    for (const node of screen.getAllByText("Manage posts")) {
      expect(node.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    }
    for (const node of screen.getAllByText("Manage channels")) {
      expect(node.closest("[aria-hidden]")).not.toHaveAttribute("aria-hidden", "true");
    }
  });
});
