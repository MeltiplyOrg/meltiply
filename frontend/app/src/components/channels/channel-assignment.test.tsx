// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChannelIntegration } from "@/api/types";
import type { BrandProfile, OAuthSelection } from "@/types";
import type * as I18nModule from "@/lib/i18n";

const alphaProfile: BrandProfile = {
  color: "#b91c1c",
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  description: null,
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha Brand",
  org_id: "00000000-0000-4000-8000-000000000010",
  purge_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const betaProfile: BrandProfile = {
  ...alphaProfile,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Beta Brand",
};

const selection: OAuthSelection = {
  accounts: [
    {
      avatar_url: null,
      display_name: "Page One",
      id: "page-one",
      username: "pageone",
    },
    {
      avatar_url: null,
      display_name: "Page Two",
      id: "page-two",
      username: null,
    },
  ],
  expires_at: "2026-10-20T15:00:00.000Z",
  id: "ticket-1",
  platform: "facebook",
};

const singleSelection: OAuthSelection = {
  ...selection,
  accounts: [selection.accounts[0]!],
};

const alphaFacebookChannel: ChannelIntegration = {
  brandProfileId: alphaProfile.id,
  disabled: false,
  id: "00000000-0000-4000-8000-000000000101",
  name: "Alpha Facebook",
  platformUserId: "page-alpha",
  providerIdentifier: "facebook",
  refreshNeeded: false,
  type: "facebook",
};

const workspace = vi.hoisted(() => ({
  brandProfiles: [] as BrandProfile[],
  integrations: [] as ChannelIntegration[],
}));

const queryState = vi.hoisted(() => ({
  selection: null as OAuthSelection | null,
}));

const actions = vi.hoisted(() => ({
  confirmMutate: vi.fn(),
  cancelMutate: vi.fn(),
  onClose: vi.fn(),
  onSuccess: vi.fn(),
}));

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => workspace,
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: true, workspaceId: "workspace-1" }),
}));
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return {
    ...actual,
    useI18n: () => ({
      language: "en" as const,
      t: (value: string, values?: Record<string, string | number>) =>
        actual.translate("en", value, values),
    }),
  };
});
vi.mock("@/lib/queries", () => ({
  useCancelOAuthSelection: () => ({ isPending: false, mutate: actions.cancelMutate }),
  useConfirmOAuthSelection: () => ({ isPending: false, mutate: actions.confirmMutate }),
  useOAuthSelection: () => ({
    data: queryState.selection,
    error: null,
    isError: false,
    isLoading: false,
  }),
}));

import { ChannelAssignment } from "./channel-assignment";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  workspace.brandProfiles = [];
  workspace.integrations = [];
});

function renderAssignment() {
  return render(
    <MemoryRouter>
      <ChannelAssignment
        selectionId="ticket-1"
        onClose={actions.onClose}
        onSuccess={actions.onSuccess}
      />
    </MemoryRouter>,
  );
}

describe("Channel assignment", () => {
  it("requires an account and an eligible Brand Profile before connecting", () => {
    queryState.selection = selection;
    workspace.brandProfiles = [alphaProfile, betaProfile];
    workspace.integrations = [alphaFacebookChannel];
    renderAssignment();

    expect(screen.queryByRole("radio", { name: /Alpha Brand/ })).not.toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Connect Channel" });
    expect(connect).toBeDisabled();

    fireEvent.click(screen.getByText("Page Two"));
    fireEvent.click(screen.getByText("Beta Brand"));
    expect(connect).toBeEnabled();

    fireEvent.click(connect);
    expect(actions.confirmMutate).toHaveBeenCalledWith(
      {
        input: { account_id: "page-two", brand_profile_id: betaProfile.id },
        selectionId: "ticket-1",
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    const [, options] = actions.confirmMutate.mock.calls[0]!;
    options.onSuccess();
    expect(actions.onSuccess).toHaveBeenCalledWith("Page Two");
  });

  it("allows the existing owner to refresh a reconnected Channel", () => {
    queryState.selection = singleSelection;
    workspace.brandProfiles = [alphaProfile];
    workspace.integrations = [
      { ...alphaFacebookChannel, platformUserId: singleSelection.accounts[0]!.id },
    ];
    renderAssignment();

    expect(screen.getByText("Reconnect this Channel")).toBeVisible();
    fireEvent.click(screen.getByText("Alpha Brand"));
    expect(screen.getByRole("button", { name: "Connect Channel" })).toBeEnabled();
  });
});
