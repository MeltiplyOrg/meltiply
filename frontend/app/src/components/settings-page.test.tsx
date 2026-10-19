// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mutation, workspace } = vi.hoisted(() => {
  const workspace = {
    canManageSettings: true,
    canManageConfiguration: true,
    canWriteContent: true,
    isAdmin: true,
    isInstallationOwner: true,
    user: {
      email: "alpha@meltiply.local",
      id: "10000000-0000-4000-8000-000000000001",
      name: "Alpha Creator",
      orgId: "20000000-0000-4000-8000-000000000005",
      role: "admin",
      isInstallationOwner: true,
    },
  };
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return { mutation, workspace };
});

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => workspace,
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({
    brandProfileId: null,
    isSignedIn: true,
    workspaceId: workspace.user.orgId,
  }),
}));

vi.mock("@/lib/queries", () => ({
  useInstallation: () => ({
    data: {
      installation_owner_user_id: workspace.user.id,
      invitations_pending: 1,
      members_active: 3,
      seat_limit: 10,
      seats_used: 4,
      workspace: {
        created_at: "2026-01-01T00:00:00.000Z",
        id: workspace.user.orgId,
        name: "Shared Studio",
        role: "admin",
        slug: "shared-studio",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
    error: null,
    isPending: false,
  }),
  useWorkspaceMembers: () => ({
    data: {
      members: [
        {
          avatar_url: null,
          created_at: "2026-01-01T00:00:00.000Z",
          display_name: "Alpha Creator",
          email: "alpha@meltiply.local",
          is_installation_owner: true,
          role: "admin",
          status: "active",
          suspended_at: null,
          updated_at: "2026-01-01T00:00:00.000Z",
          user_id: workspace.user.id,
        },
        {
          avatar_url: null,
          created_at: "2026-01-02T00:00:00.000Z",
          display_name: "Gamma Editor",
          email: "gamma@meltiply.local",
          is_installation_owner: false,
          role: "editor",
          status: "active",
          suspended_at: null,
          updated_at: "2026-01-02T00:00:00.000Z",
          user_id: "10000000-0000-4000-8000-000000000003",
        },
        {
          avatar_url: null,
          created_at: "2026-01-03T00:00:00.000Z",
          display_name: "Epsilon Suspended",
          email: "epsilon@meltiply.local",
          is_installation_owner: false,
          role: "viewer",
          status: "suspended",
          suspended_at: "2026-01-03T00:00:00.000Z",
          updated_at: "2026-01-03T00:00:00.000Z",
          user_id: "10000000-0000-4000-8000-000000000005",
        },
      ],
    },
    error: null,
    isPending: false,
  }),
  useWorkspaceInvitations: () => ({
    data: {
      invitations: [
        {
          created_at: "2026-01-01T00:00:00.000Z",
          email: "pending.invitee@meltiply.local",
          expires_at: "2026-01-08T00:00:00.000Z",
          id: "f0000000-0000-4000-8000-000000000001",
          org_id: workspace.user.orgId,
          role: "editor",
          status: "pending",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    error: null,
    isPending: false,
  }),
  useWorkspaceAudit: () => ({
    data: {
      entries: [
        {
          action: "member.role_changed",
          actor: { display_name: "Alpha Creator", email: "alpha@meltiply.local" },
          after: { role: "editor" },
          before: { role: "viewer" },
          created_at: "2026-01-01T00:05:00.000Z",
          id: "f0000000-0000-4000-8000-000000000013",
          request_id: "seed-admin-demo-role",
          target_id: "10000000-0000-4000-8000-000000000003",
          target_type: "member",
        },
      ],
    },
    error: null,
    isPending: false,
  }),
  useCreateWorkspaceInvitation: mutation,
  useResendWorkspaceInvitation: mutation,
  useRevokeWorkspaceInvitation: mutation,
  useUpdateWorkspaceMember: mutation,
  useRemoveWorkspaceMember: mutation,
  useSuspendInstallationMember: mutation,
  useReactivateInstallationMember: mutation,
  useDeleteInstallationMember: mutation,
  useTransferInstallationOwnership: mutation,
  useRenameWorkspace: mutation,
}));

import SettingsPage from "@/app/(dashboard)/settings/page";

afterEach(cleanup);

/**
 * Renders the settings route with the router context the page expects.
 *
 * @returns Testing-library render result.
 */
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/posts" element={<p>Posts destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("settings administration surface", () => {
  it("renders members, seats, and owner-only administration controls", () => {
    renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("gamma@meltiply.local")).toBeInTheDocument();
    expect(screen.getByText("epsilon@meltiply.local")).toBeInTheDocument();
    expect(screen.getByText("Installation Owner")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.getByText("pending.invitee@meltiply.local")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Invite" }).length).toBeGreaterThan(0);

    const auditTab = screen.getByRole("tab", { name: "Audit" });
    fireEvent.mouseDown(auditTab);
    fireEvent.click(auditTab);
    expect(screen.getByText("member.role_changed")).toBeInTheDocument();
    expect(screen.getByText(/alpha@meltiply.local/)).toBeInTheDocument();
  });

  it("redirects a caller without administration capability to posts", () => {
    const original = workspace.canManageSettings;
    workspace.canManageSettings = false;
    try {
      renderSettings();
      expect(screen.getByText("Posts destination")).toBeInTheDocument();
    } finally {
      workspace.canManageSettings = original;
    }
  });
});
