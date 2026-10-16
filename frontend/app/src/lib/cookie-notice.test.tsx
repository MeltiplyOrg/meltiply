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

/** UI scenarios start with no decision; only an explicit prompt action authorizes a category. */
beforeEach(() => {
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-cookie-decided");
});

/** Removes rendered controls, consent, and optional storage so every scenario owns its state. */
afterEach(() => {
  cleanup();
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
});

describe("cookie notification", () => {
  /** Any valid saved decision ends the prompt without leaving a control that can reopen it. */
  it.each([
    { functional: true, analytics: true, marketing: true },
    { functional: false, analytics: false, marketing: false },
  ])("renders no consent controls for a saved decision: %j", (choice) => {
    writeCookieConsent(choice);
    render(<CookieNotice />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(readCookieConsent()).toEqual(choice);
  });

  /** Rejecting the initial prompt records denial and keeps subsequent mounts free of consent controls. */
  it("leaves consent unset until an explicit choice and remembers rejection", () => {
    const view = render(<CookieNotice />);
    expect(screen.getByRole("region")).toBeVisible();
    expect(readCookieConsent()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject optional" }));
    expect(readCookieConsent()).toEqual({ functional: false, analytics: false, marketing: false });
    view.unmount();
    render(<CookieNotice />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /** Initial category management starts denied and grants only the categories explicitly selected. */
  it("starts categories unchecked and saves functional consent without tracking consent", () => {
    render(<CookieNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Manage preferences" }));
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(readCookieConsent()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Functional preferences/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(readCookieConsent()).toEqual({ functional: true, analytics: false, marketing: false });
  });

  /** The initial management flow focuses its options and confirmation, then dismisses without stealing moved focus. */
  it("dismisses confirmation without returning focus to a reopen control", () => {
    vi.useFakeTimers();
    const elsewhere = document.createElement("button");
    try {
      render(<CookieNotice />);
      fireEvent.click(screen.getByRole("button", { name: "Manage preferences" }));
      expect(document.activeElement).toBe(screen.getByRole("group"));
      fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
      const status = screen.getByRole("status");
      expect(document.activeElement).toBe(status.parentElement);
      expect(readCookieConsent()).toEqual({ functional: true, analytics: true, marketing: true });
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
