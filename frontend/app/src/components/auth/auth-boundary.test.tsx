// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AuthBoundary } from "./auth-boundary";
import * as authClientModule from "@/lib/auth-client";

function renderBoundary() {
  return render(
    <AuthBoundary>
      <div>authenticated children</div>
    </AuthBoundary>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthBoundary", () => {
  it("renders children when session resolves", async () => {
    vi.spyOn(authClientModule.authClient, "getSession").mockResolvedValue({
      session: { id: "sess-1", userId: "user-1", expiresAt: new Date() },
      user: { id: "user-1", email: "user@example.com" },
    });

    renderBoundary();
    await waitFor(() => {
      expect(screen.getByText("authenticated children")).toBeInTheDocument();
    });
  });

  it("shows a visible status while session loads", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    vi.spyOn(authClientModule.authClient, "getSession").mockReturnValue(promise as never);

    renderBoundary();

    expect(screen.getByRole("status")).toBeInTheDocument();

    resolve(null);
    await waitFor(() => {
      expect(screen.getByText("authenticated children")).toBeInTheDocument();
    });
  });
});
