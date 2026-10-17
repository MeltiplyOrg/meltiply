// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  TopToolbarFilterChip,
  TopToolbarFilters,
  TopToolbarSearch,
  TopToolbarReset,
} from "@/components/layout/top-toolbar";
import { I18nProvider } from "@/lib/i18n";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.lang = "en";
});

describe("collection toolbar interactions", () => {
  it("clears a localized search, restores filter disclosure focus, and animates the close", async () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    window.localStorage.setItem("meltiply.language", "es");
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <TopToolbarSearch value="meltiply" onChange={onChange} placeholder="Search posts" />
        <TopToolbarFilters
          activeCount={1}
          onClearAll={vi.fn()}
          fields={[
            {
              id: "status",
              label: "Status",
              active: true,
              onClear: vi.fn(),
              control: <button type="button">Status choices</button>,
            },
          ]}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Limpiar búsqueda" }));
    expect(onChange).toHaveBeenCalledWith("");
    const filter = screen.getByText("Filtrar").closest("summary");
    expect(filter).not.toBeNull();
    fireEvent.click(filter!);
    expect(screen.getByText("Status choices")).toBeVisible();
    fireEvent.keyDown(filter!.parentElement!, { key: "Escape" });
    // Focus returns immediately; the disclosure itself stays mounted through the
    // shared menu exit animation and closes when it finishes.
    expect(filter).toHaveFocus();
    const panel = document.querySelector<HTMLElement>("[data-menu-surface]");
    expect(panel?.dataset.state).toBe("closed");
    await vi.waitFor(() => expect(filter!.parentElement).not.toHaveAttribute("open"));
  });

  it("removes a single active chip and resets all filters only when requested", () => {
    const onClear = vi.fn();
    const onReset = vi.fn();
    render(
      <>
        <TopToolbarFilterChip label="Instagram" onClear={onClear} />
        <TopToolbarReset hasActiveFilters onReset={onReset} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear Instagram filter" }));
    expect(onClear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});
