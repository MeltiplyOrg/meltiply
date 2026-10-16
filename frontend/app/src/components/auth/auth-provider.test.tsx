// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { authSessionRefreshedEvent } from "@/lib/runtime-events";
import { authClient } from "@/lib/auth-client";

import { AppAuthProvider, RequireAuth, useMeltiplyAuth } from "./auth-provider";

vi.mock("@/components/layout/runtime-status", () => ({ RuntimeStatus: () => null }));

function SessionConsumer({ name }: { name: string }) {
  const { isSignedIn, user, workspaceId } = useMeltiplyAuth();
  return (
    <output aria-label={name}>
      {isSignedIn ? `${user?.email}:${workspaceId ?? "personal"}` : "signed-out"}
    </output>
  );
}

function WorkspaceSelector() {
  const { setWorkspaceId } = useMeltiplyAuth();
  return <button onClick={() => setWorkspaceId("ws-1")}>select-workspace</button>;
}

function renderConsumers() {
  return render(
    <AppAuthProvider>
      <SessionConsumer name="primary" />
      <SessionConsumer name="secondary" />
      <SessionConsumer name="tertiary" />
    </AppAuthProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Better Auth JWT session lifecycle", () => {
  it("resolves one session for every mounted consumer", async () => {
    const getSessionMock = vi.spyOn(authClient, "getSession").mockResolvedValue({
      session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
      user: { email: "user@example.com", id: "user-1" },
    });

    renderConsumers();

    await waitFor(() => {
      expect(screen.getByLabelText("primary")).toHaveTextContent("user@example.com:personal");
      expect(screen.getByLabelText("secondary")).toHaveTextContent("user@example.com:personal");
      expect(screen.getByLabelText("tertiary")).toHaveTextContent("user@example.com:personal");
    });
    expect(getSessionMock).toHaveBeenCalledOnce();
  });

  it("refreshes the session JWT on visibility event", async () => {
    const getSessionMock = vi
      .spyOn(authClient, "getSession")
      .mockResolvedValueOnce({
        session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
        user: { email: "first@example.com", id: "user-1" },
      })
      .mockResolvedValueOnce({
        session: { expiresAt: new Date(), id: "session-2", userId: "user-1" },
        user: { email: "second@example.com", id: "user-1" },
      });

    renderConsumers();
    await waitFor(() => expect(screen.getAllByText(/first@example\.com/)).toHaveLength(3));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(screen.getAllByText(/second@example\.com/)).toHaveLength(3));
    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });

  it("shares scheduled and explicit JWT refreshes with every consumer", async () => {
    vi.useFakeTimers();
    const getSessionMock = vi.spyOn(authClient, "getSession").mockResolvedValue({
      session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
      user: { email: "user@example.com", id: "user-1" },
    });

    renderConsumers();
    await act(async () => undefined);
    expect(getSessionMock).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    });
    expect(getSessionMock).toHaveBeenCalledTimes(2);

    act(() => {
      window.dispatchEvent(new CustomEvent(authSessionRefreshedEvent));
    });
    await act(async () => undefined);
    expect(getSessionMock).toHaveBeenCalledTimes(3);
  });

  it("scopes workspace selection per request and resets it when the session user changes", async () => {
    const getSessionMock = vi
      .spyOn(authClient, "getSession")
      .mockResolvedValueOnce({
        session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
        user: { email: "first@example.com", id: "user-1" },
      })
      .mockResolvedValueOnce({
        session: { expiresAt: new Date(), id: "session-2", userId: "user-2" },
        user: { email: "other@example.com", id: "user-2" },
      });

    render(
      <AppAuthProvider>
        <SessionConsumer name="primary" />
        <WorkspaceSelector />
      </AppAuthProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("primary")).toHaveTextContent("first@example.com:personal"),
    );

    act(() => {
      screen.getByText("select-workspace").click();
    });
    await waitFor(() =>
      expect(screen.getByLabelText("primary")).toHaveTextContent("first@example.com:ws-1"),
    );

    // A refresh resolving to a different user must drop the previous workspace
    // selection so a stale workspace ID never leaks into another user's requests.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(authSessionRefreshedEvent));
    });
    await waitFor(() =>
      expect(screen.getByLabelText("primary")).toHaveTextContent("other@example.com:personal"),
    );
    expect(getSessionMock).toHaveBeenCalledTimes(2);
  });

  it("RequireAuth renders children when signed in", async () => {
    vi.spyOn(authClient, "getSession").mockResolvedValue({
      session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
      user: { email: "user@example.com", id: "user-1" },
    });

    render(
      <MemoryRouter>
        <AppAuthProvider>
          <RequireAuth>
            <div>protected content</div>
          </RequireAuth>
        </AppAuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("protected content")).toBeInTheDocument();
    });
  });
});
