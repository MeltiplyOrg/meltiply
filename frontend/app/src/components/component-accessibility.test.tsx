// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { RuntimeStatus } from "@/components/layout/runtime-status";
import { runtimeStatusEvent, type RuntimeStatusDetail } from "@/lib/runtime-events";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigation.push,
}));

vi.mock("@/components/auth/auth-provider", () => ({
  useMeltiplyAuth: () => ({
    isSignedIn: true,
    setWorkspaceId: () => {},
    workspaceId: null,
  }),
}));

const server = setupServer(
  http.post("*/__frontend-telemetry", () => new HttpResponse(null, { status: 204 })),
);

async function expectNoAutomatedViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: {
      // JSDOM cannot calculate rendered color contrast. Browser acceptance
      // remains the authority for this rule.
      "color-contrast": { enabled: false },
    },
  });
  expect(result.violations).toEqual([]);
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  navigation.push.mockReset();
});

afterAll(() => {
  server.close();
});

describe("contract-backed component accessibility", () => {
  it.each<{
    action: string;
    detail: RuntimeStatusDetail;
  }>([
    {
      action: "Sign in again",
      detail: {
        kind: "auth-expired",
        message: "Your session expired.",
      },
    },
    {
      action: "Dismiss",
      detail: {
        kind: "active-organization",
        message: "Choose an active organization.",
      },
    },
    {
      action: "Dismiss",
      detail: {
        kind: "maintenance",
        message: "The API is under maintenance.",
      },
    },
    {
      action: "Dismiss",
      detail: {
        kind: "recoverable",
        message: "The request can be retried.",
      },
    },
  ])("renders the $detail.kind runtime state with a safe action", async ({ action, detail }) => {
    const { container } = render(<RuntimeStatus />);
    fireEvent(window, new CustomEvent(runtimeStatusEvent, { detail }));

    const notice = await screen.findByText(detail.message);
    expect(notice).toBeVisible();
    expect(notice.closest("[role]")).toHaveClass("fixed");
    expect(screen.queryByText(/Request ID:/)).not.toBeInTheDocument();
    const actionElement = screen.getByRole(action === "Dismiss" ? "button" : "link", {
      name: action,
    });
    expect(actionElement).toBeVisible();
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss).toBeVisible();
    await expectNoAutomatedViolations(container);

    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByText(detail.message)).not.toBeInTheDocument());
  });

  it("announces offline state politely and clears it when connectivity returns", async () => {
    const { container } = render(<RuntimeStatus />);
    fireEvent.offline(window);

    const status = await screen.findByRole("status");
    expect(status).toHaveClass("fixed");
    expect(status).toHaveTextContent("Changes are paused until your connection returns.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expectNoAutomatedViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());

    fireEvent.offline(window);
    await screen.findByRole("status");
    fireEvent.online(window);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
