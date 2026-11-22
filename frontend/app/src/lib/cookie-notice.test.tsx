// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CookieNotice } from "@meltiply/ui/cookie-notice";
import {
  consentCookieName,
  readCookieConsent,
  writeCookieConsent,
} from "@meltiply/ui/cookie-consent";

beforeEach(() => {
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-cookie-decided");
});

afterEach(() => {
  cleanup();
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
});

describe("cookie notification", () => {
  it.each([{ functional: true }, { functional: false }])(
    "renders no consent controls for a saved decision: %j",
    (choice) => {
      writeCookieConsent(choice);
      render(<CookieNotice />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
      expect(readCookieConsent()).toEqual(choice);
    },
  );

  it("leaves consent unset until an explicit choice and remembers rejection", () => {
    const view = render(<CookieNotice />);
    expect(screen.getByRole("region")).toBeVisible();
    expect(readCookieConsent()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject optional" }));
    expect(readCookieConsent()).toEqual({ functional: false });
    view.unmount();
    render(<CookieNotice />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers only the implemented optional purpose and saves it only when chosen", () => {
    render(<CookieNotice />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Analytics/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Marketing/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage preferences" }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).not.toBeChecked();
    expect(readCookieConsent()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Functional preferences/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(readCookieConsent()).toEqual({ functional: true });
  });

  it("accepts only functional preferences from the initial prompt", () => {
    render(<CookieNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Allow functional" }));
    expect(readCookieConsent()).toEqual({ functional: true });
  });

  it("dismisses confirmation without returning focus to a reopen control", () => {
    vi.useFakeTimers();
    const elsewhere = document.createElement("button");
    try {
      render(<CookieNotice />);
      fireEvent.click(screen.getByRole("button", { name: "Manage preferences" }));
      expect(document.activeElement).toBe(screen.getByRole("group"));
      fireEvent.click(screen.getByRole("button", { name: "Allow functional" }));
      const status = screen.getByRole("status");
      expect(document.activeElement).toBe(status.parentElement);
      expect(readCookieConsent()).toEqual({ functional: true });
      document.body.appendChild(elsewhere);
      elsewhere.focus();
      act(() => vi.advanceTimersByTime(1800));
      expect(screen.getByRole("status")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(elsewhere);
      expect(screen.getAllByRole("button")).toEqual([elsewhere]);
    } finally {
      elsewhere.remove();
      vi.useRealTimers();
    }
  });
});
