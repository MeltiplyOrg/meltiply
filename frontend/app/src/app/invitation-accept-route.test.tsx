// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  acceptMutate: vi.fn(),
  isSignedIn: false,
  preview: {
    data: null as {
      email: string;
      expires_at: string;
      role: "admin" | "editor" | "viewer";
      status: "accepted" | "expired" | "pending" | "revoked";
      workspace_name: string;
    } | null,
    error: null as Error | null,
    isPending: false,
  },
  signUpEmail: vi.fn(),
}));

vi.mock("@/components/auth/auth-boundary", () => ({
  AuthBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/providers", () => ({
  AppProviders: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/auth/auth-provider", () => ({
  useMeltiplyAuth: () => ({
    isSignedIn: state.isSignedIn,
    refreshSession: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ brandProfileId: null, isSignedIn: state.isSignedIn }),
}));
vi.mock("@/lib/queries", () => ({
  useAcceptWorkspaceInvitation: () => ({
    isPending: false,
    mutate: state.acceptMutate,
  }),
  useInvitationPreview: () => state.preview,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signUpEmail: state.signUpEmail },
}));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useI18n: () => ({
      language: "en",
      setLanguage: () => undefined,
      t: (message: string, values?: Record<string, string>) =>
        message.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? `{${key}}`),
      tStatus: (status: string) => status,
    }),
  };
});

import InvitationAcceptRoute from "@/app/invitation-accept-route";

const token = "permission-preview-token-for-ui";

function renderRoute(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/invitations/accept${search}`]}>
      <InvitationAcceptRoute />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.isSignedIn = false;
  state.preview = { data: null, error: null, isPending: false };
});

describe("invitation acceptance route", () => {
  it("explains a missing token instead of rendering a form", () => {
    renderRoute("");
    expect(screen.getByText("This invitation link is missing its token.")).toBeInTheDocument();
  });

  it("renders the locked-email account form for a pending invitation", () => {
    state.preview = {
      data: {
        email: "invitee@meltiply.local",
        expires_at: "2026-01-08T00:00:00.000Z",
        role: "editor",
        status: "pending",
        workspace_name: "Shared Studio",
      },
      error: null,
      isPending: false,
    };
    renderRoute(`?token=${token}`);

    expect(screen.getByRole("heading", { name: "Join Shared Studio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("invitee@meltiply.local");
    expect(screen.getByText("The invitation is locked to this email address.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });

  it("accepts automatically for a signed-in invitee", async () => {
    state.isSignedIn = true;
    state.preview = {
      data: {
        email: "invitee@meltiply.local",
        expires_at: "2026-01-08T00:00:00.000Z",
        role: "viewer",
        status: "pending",
        workspace_name: "Shared Studio",
      },
      error: null,
      isPending: false,
    };
    renderRoute(`?token=${token}`);

    await waitFor(() => {
      expect(state.acceptMutate).toHaveBeenCalledWith(token, expect.any(Object));
    });
    expect(screen.getByText("Accepting your invitation…")).toBeInTheDocument();
  });

  it("keeps the joined state when the invitation preview refreshes to accepted", async () => {
    state.isSignedIn = true;
    state.preview = {
      data: {
        email: "invitee@meltiply.local",
        expires_at: "2026-01-08T00:00:00.000Z",
        role: "viewer",
        status: "pending",
        workspace_name: "Shared Studio",
      },
      error: null,
      isPending: false,
    };
    state.acceptMutate.mockImplementationOnce(
      (_token: string, callbacks: { onSuccess: () => Promise<void> }) => {
        void callbacks.onSuccess();
      },
    );
    const view = renderRoute(`?token=${token}`);
    await screen.findByText("You joined the workspace.");

    state.preview = {
      ...state.preview,
      data: { ...state.preview.data!, status: "accepted" },
    };
    view.rerender(
      <MemoryRouter initialEntries={[`/invitations/accept?token=${token}`]}>
        <InvitationAcceptRoute />
      </MemoryRouter>,
    );

    expect(screen.getByText("You joined the workspace.")).toBeInTheDocument();
    expect(screen.queryByText(/no longer pending/)).not.toBeInTheDocument();
  });

  it("reports an invalid or expired invitation", () => {
    state.preview = {
      data: null,
      error: new Error("invitation_expired"),
      isPending: false,
    };
    renderRoute(`?token=${token}`);
    expect(
      screen.getByText("This invitation is invalid, expired, or already used."),
    ).toBeInTheDocument();
  });

  it("guides an unverified invitee to verify their email", async () => {
    state.isSignedIn = true;
    state.preview = {
      data: {
        email: "invitee@meltiply.local",
        expires_at: "2026-01-08T00:00:00.000Z",
        role: "editor",
        status: "pending",
        workspace_name: "Shared Studio",
      },
      error: null,
      isPending: false,
    };
    renderRoute(`?token=${token}`);

    await waitFor(() => expect(state.acceptMutate).toHaveBeenCalled());
    const options = state.acceptMutate.mock.calls[0]?.[1] as {
      onError: (cause: unknown) => void;
    };
    act(() => {
      options.onError({
        code: "email_verification_required",
        message: "Verify your email before joining the workspace.",
        status: 403,
      });
    });

    expect(
      await screen.findByText("Verify your email address, then return to this page to join."),
    ).toBeInTheDocument();
  });

  it("shows safe copy for a non-verification acceptance failure", async () => {
    state.isSignedIn = true;
    state.preview = {
      data: {
        email: "invitee@meltiply.local",
        expires_at: "2026-01-08T00:00:00.000Z",
        role: "editor",
        status: "pending",
        workspace_name: "Shared Studio",
      },
      error: null,
      isPending: false,
    };
    renderRoute(`?token=${token}`);

    await waitFor(() => expect(state.acceptMutate).toHaveBeenCalled());
    const options = state.acceptMutate.mock.calls[0]?.[1] as {
      onError: (cause: unknown) => void;
    };
    act(() => {
      options.onError(
        Object.assign(new Error("We could not verify this invitation."), {
          code: "invitation_conflict",
        }),
      );
    });

    expect(await screen.findByText("An error has occurred.")).toBeInTheDocument();
    expect(screen.queryByText(/Verify your email address/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We could not verify/)).not.toBeInTheDocument();
  });
});
