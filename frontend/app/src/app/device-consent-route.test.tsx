// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  approve: null as null | (() => Response | Promise<Response>),
  auth: {
    isSignedIn: true,
    signOut: vi.fn(),
    user: {
      email: "owner@meltiply.local",
      id: "user-1",
      name: "Owner",
    } as { email: string; id: string; name: string } | null,
  },
  currentUser: {
    data: {
      active_organization: {
        id: "org-1",
        name: "Shared Studio",
        role: "admin",
        slug: "shared",
      },
      is_installation_owner: false,
    } as null | {
      active_organization: { id: string; name: string; role: string; slug: string };
      is_installation_owner: boolean;
    },
    isPending: false,
  },
  deny: null as null | (() => Response | Promise<Response>),
  review: null as null | (() => Response | Promise<Response>),
  reviewCalls: 0,
}));

vi.mock("@/components/auth/auth-boundary", () => ({
  AuthBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/providers", () => ({
  AppProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/auth/auth-provider", () => ({
  useMeltiplyAuth: () => ({
    isSignedIn: state.auth.isSignedIn,
    signOut: state.auth.signOut,
    user: state.auth.user,
  }),
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ brandProfileId: null, isSignedIn: state.auth.isSignedIn }),
}));
vi.mock("@/lib/queries", () => ({
  useCurrentUser: () => state.currentUser,
}));
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    t: (message: string, values?: Record<string, number | string>) =>
      message.replace(/\{(\w+)\}/g, (_match, key: string) =>
        values?.[key] === undefined ? `{${key}}` : String(values[key]),
      ),
  }),
}));

import DeviceConsentRoute from "@/app/device-consent-route";

/**
 * Builds a JSON HTTP response for the fake auth transport.
 *
 * @param body - JSON-serializable response body.
 * @param status - HTTP status code.
 * @param headers - Additional response headers.
 * @returns Response observed by the consent route.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

/**
 * A review response describing a pending melti-cli request, unless overridden.
 *
 * @param overrides - Partial review payload.
 * @returns Pending review response.
 */
function pendingReview(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    client_id: "melti-cli",
    scope: "",
    status: "pending",
    user_code: "ABCD2345",
    ...overrides,
  });
}

/**
 * Records every device-authorization request the route issues.
 *
 * @returns Requests in call order.
 */
function installDeviceFetch() {
  const requests: { body: unknown; method: string | undefined; url: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      method: init?.method,
      url,
    });
    if (url.endsWith("/api/auth/device/approve")) {
      return state.approve ? state.approve() : jsonResponse({ success: true });
    }
    if (url.endsWith("/api/auth/device/deny")) {
      return state.deny ? state.deny() : jsonResponse({ success: true });
    }
    if (url.includes("/api/auth/device?user_code=")) {
      state.reviewCalls += 1;
      return state.review ? state.review() : pendingReview();
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

/**
 * Mirrors the router location so redirects and retained codes are observable.
 *
 * @returns Plain-text pathname and search.
 */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

/**
 * Renders the device consent route with the router entry under test.
 *
 * @param entry - Router path including any prefilled user code.
 * @returns Testing-library render result.
 */
function renderRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <DeviceConsentRoute />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/**
 * Resolves the redirect query value from the observed location.
 *
 * @returns The decoded redirect path, or null when absent.
 */
function redirectTarget(): string | null {
  const location = screen.getByTestId("location").textContent ?? "";
  const query = location.split("?")[1];
  return query ? new URLSearchParams(query).get("redirect") : null;
}

/**
 * Clicks the explicit matching-code confirmation.
 */
function confirmMatchingCode(): void {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "The code in my terminal matches this code." }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.approve = null;
  state.auth.isSignedIn = true;
  state.auth.user = { email: "owner@meltiply.local", id: "user-1", name: "Owner" };
  state.currentUser.data = {
    active_organization: { id: "org-1", name: "Shared Studio", role: "admin", slug: "shared" },
    is_installation_owner: false,
  };
  state.currentUser.isPending = false;
  state.deny = null;
  state.review = null;
  state.reviewCalls = 0;
});

describe("device consent route", () => {
  it("sends a signed-out visitor through sign-in with the same-origin route and code retained", async () => {
    state.auth.isSignedIn = false;
    const { fetchMock } = installDeviceFetch();

    renderRoute("/device?user_code=abcd-2345");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sign-in"));
    expect(redirectTarget()).toBe("/device?user_code=ABCD2345");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies a prefilled code, displays the request, and never approves on load", async () => {
    const { fetchMock, requests } = installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");

    const heading = await screen.findByRole("heading", { name: "Approve melti-cli?" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("ABCD2345", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByText("melti-cli", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("owner@meltiply.local", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Shared Studio", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Admin", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Create and edit Posts.")).toBeInTheDocument();
    expect(
      screen.getByText("Manage Workspace members and invitations."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Approve only if you started melti-cli auth login on a device you control. Never approve a code someone sent you: approval gives that terminal access to your Workspace.",
      ),
    ).toBeInTheDocument();

    const approve = screen.getByRole("button", { name: "Approve melti-cli" });
    expect(approve).toBeDisabled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("http://localhost:8787/api/auth/device?user_code=ABCD2345");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    confirmMatchingCode();
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await screen.findByRole("heading", { name: "melti-cli is approved" });
    const approval = requests.find((request) => request.method === "POST");
    expect(approval?.url).toBe("http://localhost:8787/api/auth/device/approve");
    expect(approval?.body).toEqual({ userCode: "ABCD2345" });
  });

  it("accepts a manually entered code and keeps the code in the review URL", async () => {
    const { requests } = installDeviceFetch();

    renderRoute("/device");
    expect(screen.queryByRole("button", { name: "Approve melti-cli" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Device code"), {
      target: { value: "abcd 2345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find request" }));

    await screen.findByText("ABCD2345", { selector: "code" });
    expect(requests[0]?.url).toBe("http://localhost:8787/api/auth/device?user_code=ABCD2345");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/device?user_code=ABCD2345"),
    );
  });

  it("denies a request without requiring the matching-code confirmation", async () => {
    const { requests } = installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");
    await screen.findByRole("heading", { name: "Approve melti-cli?" });
    fireEvent.click(screen.getByRole("button", { name: "Deny request" }));

    await screen.findByRole("heading", { name: "Access denied" });
    const denial = requests.find((request) => request.method === "POST");
    expect(denial?.url).toBe("http://localhost:8787/api/auth/device/deny");
    expect(denial?.body).toEqual({ userCode: "ABCD2345" });
  });

  it("shows the current Workspace access without inventing write authority for Viewers", async () => {
    state.currentUser.data = {
      active_organization: { id: "org-1", name: "Shared Studio", role: "viewer", slug: "shared" },
      is_installation_owner: false,
    };
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");
    await screen.findByRole("heading", { name: "Approve melti-cli?" });

    expect(screen.getByText("Viewer", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Read Posts, Channels, and Analytics.")).toBeInTheDocument();
    expect(screen.queryByText("Create and edit Posts.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Manage Workspace members and invitations."),
    ).not.toBeInTheDocument();
  });

  it("explains an invalid code and keeps manual entry available", async () => {
    state.review = () =>
      jsonResponse({ error: "invalid_request", error_description: "Invalid user code" }, 400);
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");

    await screen.findByText(
      "That code doesn't match an active request. Check the code in your terminal and try again.",
    );
    expect(screen.getByLabelText("Device code")).toHaveValue("ABCD2345");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve melti-cli" })).not.toBeInTheDocument();
  });

  it("explains expiry and tells the member to restart the CLI login", async () => {
    state.review = () =>
      jsonResponse({ error: "expired_token", error_description: "User code has expired" }, 400);
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");

    await screen.findByText("This code has expired. Run melti-cli auth login again to get a new code.");
  });

  it("shows a terminal outcome when the request was already approved", async () => {
    state.review = () => jsonResponse({ status: "approved", user_code: "ABCD2345" });
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");

    await screen.findByRole("heading", { name: "This request was already approved" });
    expect(screen.queryByRole("button", { name: "Approve melti-cli" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny request" })).not.toBeInTheDocument();
  });

  it("refuses to let another signed-in account act on a claimed request", async () => {
    state.review = () => jsonResponse({ status: "pending", user_code: "ABCD2345" });
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");

    await screen.findByText(
      "This request belongs to a different account. Sign out and sign in with the account that started it.",
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve melti-cli" })).not.toBeInTheDocument();
  });

  it("reports a concurrent approval as already processed instead of claiming success", async () => {
    state.review = () => {
      if (state.reviewCalls === 1) return pendingReview();
      return jsonResponse({ status: "approved", user_code: "ABCD2345" });
    };
    state.approve = () =>
      jsonResponse(
        { error: "invalid_request", error_description: "Device code already processed" },
        400,
      );
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");
    await screen.findByRole("heading", { name: "Approve melti-cli?" });
    confirmMatchingCode();
    fireEvent.click(screen.getByRole("button", { name: "Approve melti-cli" }));

    await screen.findByRole("heading", { name: "This request was already approved" });
  });

  it("reports rate limiting with the server's delay and leaves the decision available", async () => {
    state.approve = () =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            details: [],
            issues: [],
            message: "Too many authentication attempts. Retry later.",
            request_id: "req-1",
            retryable: true,
          },
        },
        429,
        { "Retry-After": "12" },
      );
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");
    await screen.findByRole("heading", { name: "Approve melti-cli?" });
    confirmMatchingCode();
    fireEvent.click(screen.getByRole("button", { name: "Approve melti-cli" }));

    await screen.findByText("Too many attempts. Wait 12 seconds and try again.");
    expect(screen.getByRole("heading", { name: "Approve melti-cli?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve melti-cli" })).toBeEnabled();
  });

  it("asks for sign-in again when the approving session has ended", async () => {
    state.approve = () =>
      jsonResponse({ error: "unauthorized", error_description: "Authentication required" }, 401);
    installDeviceFetch();

    renderRoute("/device?user_code=ABCD2345");
    await screen.findByRole("heading", { name: "Approve melti-cli?" });
    confirmMatchingCode();
    fireEvent.click(screen.getByRole("button", { name: "Approve melti-cli" }));

    await screen.findByText("Your session ended. Sign in again to continue.");
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });
});
