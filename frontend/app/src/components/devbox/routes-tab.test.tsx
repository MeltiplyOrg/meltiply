// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RoutesTab } from "./routes-tab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Verifies the live request starter uses the canonical auth transport and opens
 * only the verification URL returned for this origin.
 */
describe("Routes tab", () => {
  it("starts a device request and opens the consent route", async () => {
    const destination = new URL("/device?user_code=ABCD2345", window.location.origin).href;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ verification_uri_complete: destination }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onNavigate = vi.fn();

    render(<RoutesTab onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Start device request" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(destination));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Expected one device-code request");
    const [input, init] = call;
    expect(String(input)).toBe(new URL("/api/auth/device/code", window.location.origin).href);
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: "melti-cli" });
  });

  it("reports a failed request without leaving the current page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const onNavigate = vi.fn();

    render(<RoutesTab onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Start device request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start a device request.");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
