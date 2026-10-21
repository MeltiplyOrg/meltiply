// @vitest-environment jsdom
import { useEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as I18nModule from "@/lib/i18n";
import type { BrandProfile, PlatformAccount } from "@/types";

const listeners = vi.hoisted(() => new Set<() => void>());
function notifyWorkspace() {
  listeners.forEach((l) => l());
}

const workspace = vi.hoisted(() => ({
  brandProfiles: [] as BrandProfile[],
  channelStatuses: [],
  integrations: [],
  isAdmin: true,
  selectedBrandProfile: null as BrandProfile | null,
  selectedBrandProfileId: null as string | null,
  setSelectedBrandProfileId: vi.fn((id: string | null) => {
    workspace.selectedBrandProfileId = id;
    workspace.selectedBrandProfile = workspace.brandProfiles.find((p) => p.id === id) ?? null;
    notifyWorkspace();
  }),
  selectedPlatforms: [] as string[],
  setSelectedPlatforms: vi.fn((update: string[] | ((prev: string[]) => string[])) => {
    workspace.selectedPlatforms =
      typeof update === "function" ? update(workspace.selectedPlatforms) : update;
    notifyWorkspace();
  }),
  user: { name: "Alpha Admin" },
  workspaceName: "Alpha Workspace",
}));

const queryMutations = vi.hoisted(() => ({
  create: { error: null, mutate: vi.fn() },
  delete: { error: null as Error | null, mutate: vi.fn() },
  disconnect: { isPending: false, mutateAsync: vi.fn() },
  oauth: { mutateAsync: vi.fn() },
  update: { error: null, mutate: vi.fn() },
}));

const queryResults = vi.hoisted(() => ({
  capabilities: { data: [], error: null },
  platforms: {
    data: [] as PlatformAccount[],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => {
    const [, setTick] = useState(0);
    useEffect(() => {
      const listener = () => setTick((t) => t + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return {
      ...workspace,
      canManageConfiguration: true,
      canManageSettings: true,
      canWriteContent: true,
      isInstallationOwner: false,
      logout: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: true, workspaceId: "workspace-1" }),
}));
/** Uses the real English translator so bulk counts and confirmation snapshots exercise interpolation. */
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return {
    ...actual,
    useI18n: () => ({
      t: (value: string, values?: Record<string, string | number>) =>
        actual.translate("en", value, values),
      tStatus: (value: string) => value,
    }),
  };
});
vi.mock("@/lib/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    requestedTheme: "light",
    setTheme: vi.fn(),
    theme: "light",
    toggleTheme: vi.fn(),
  }),
}));
vi.mock("@/lib/queries", () => ({
  useCreateBrandProfile: () => queryMutations.create,
  useDeleteBrandProfile: () => queryMutations.delete,
  useDisconnectPlatform: () => queryMutations.disconnect,
  usePlatformCapabilities: () => queryResults.capabilities,
  usePlatforms: () => queryResults.platforms,
  useStartPlatformOAuth: () => queryMutations.oauth,
  useUpdateBrandProfile: () => queryMutations.update,
}));
vi.mock("@meltiply/ui/toast", () => ({
  toast: toastMock,
}));
vi.mock("@meltiply/ui/sidebar-glide-highlight", () => ({
  SidebarGlideHighlight: () => null,
}));

import { ChannelsView } from "./channels-view";

const alphaProfile: BrandProfile = {
  color: "#b91c1c",
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  description: "Editorial tools for independent publishers.",
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha Brand",
  org_id: "00000000-0000-4000-8000-000000000010",
  purge_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const betaProfile: BrandProfile = {
  ...alphaProfile,
  id: "00000000-0000-4000-8000-000000000003",
  name: "Beta Brand",
};

const connectedAccount: PlatformAccount = {
  avatar_url: null,
  username: null,
  brand_profile_id: alphaProfile.id,
  capabilities: {
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    connect_available: false,
    max_caption_length: null,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: 0,
    multi_asset_types: [],
    notes: [],
    platform: "tiktok",
    publish: false,
    reply: false,
  },
  connection_status: "connected",
  created_at: "2026-01-01T00:00:00.000Z",
  display_name: "Alpha TikTok",
  id: "00000000-0000-4000-8000-000000000011",
  last_synced_at: null,
  org_id: alphaProfile.org_id,
  platform: "tiktok",
  platform_user_id: "alpha-tiktok",
  rate_limit_budget: null,
  scopes: [],
  token_expires_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const youtubeAccount: PlatformAccount = {
  ...connectedAccount,
  connection_status: "expired",
  display_name: "Alpha YouTube",
  id: "00000000-0000-4000-8000-000000000012",
  platform: "youtube",
  platform_user_id: "alpha-youtube",
};

const betaAccount: PlatformAccount = {
  ...connectedAccount,
  brand_profile_id: betaProfile.id,
  connection_status: "reconnect_required",
  display_name: "Beta Instagram",
  id: "00000000-0000-4000-8000-000000000013",
  platform: "instagram",
  platform_user_id: "beta-instagram",
};

/** Resets mocked workspace and query state so each rendered surface starts independent. */
function resetScope() {
  workspace.brandProfiles = [alphaProfile, betaProfile];
  workspace.channelStatuses = [];
  workspace.integrations = [];
  workspace.isAdmin = true;
  workspace.selectedBrandProfile = null;
  workspace.selectedBrandProfileId = null;
  workspace.selectedPlatforms = [];
  workspace.setSelectedBrandProfileId.mockClear();
  workspace.setSelectedPlatforms.mockClear();
  queryMutations.disconnect.mutateAsync.mockReset();
  queryMutations.disconnect.isPending = false;
  queryResults.platforms.data = [];
  toastMock.mockClear();
}

/** The routed ChannelsView element, reused for re-renders that simulate data refetches. */
function channelsElement() {
  return (
    <MemoryRouter>
      <ChannelsView />
    </MemoryRouter>
  );
}

/** Mounts the channels view inside a router context for its search-param reads. */
function renderChannels() {
  return render(channelsElement());
}

/** The single bulk pill action button, disambiguated from settings-disconnect buttons. */
function bulkActionButton() {
  return screen.getByRole("button", { name: "Disconnect" });
}

/**
 * The selection dock. Its live count is a `RollingCount`, so the sentence is split
 * across nodes — read it as the text a person sees rather than as one element's label.
 */
function selectionDock() {
  const region = screen.queryByRole("region", { name: "Selection actions" });
  return region ? within(region).queryByRole("status") : null;
}

async function expectSelection(text: string) {
  await waitFor(() => expect(selectionDock()?.textContent).toBe(text));
}

beforeAll(() => {
  // jsdom does not implement scrollIntoView; Radix Select calls it when its
  // popover content mounts and focuses the selected item.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});
beforeEach(() => {
  resetScope();
});

describe("Channels selection", () => {
  /**
   * The table header select-all acts on exactly the visible rows: hidden-by-filter
   * channels are untouched, and the same checkbox clears the visible set.
   */
  it("selects only visible channels through the table header select-all", async () => {
    queryResults.platforms.data = [connectedAccount, youtubeAccount, betaAccount];
    renderChannels();

    fireEvent.change(screen.getByLabelText("Search accounts"), {
      target: { value: "tiktok" },
    });
    expect(screen.getByText("Alpha TikTok")).toBeVisible();
    expect(screen.queryByText("Alpha YouTube")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible channels" }));
    await expectSelection("1 selected");
    expect(screen.getByTestId(`channel-row-${connectedAccount.id}`)).toHaveAttribute(
      "data-selected",
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible channels" }));
    await waitFor(() => expect(selectionDock()).toBeNull());
  });

  /**
   * Selection survives rows being filtered out: a hidden selected channel still
   * counts toward the bulk pill and stays checked once it becomes visible again.
   */
  it("keeps hidden selected rows latched and restores them checked", async () => {
    queryResults.platforms.data = [connectedAccount, youtubeAccount];
    renderChannels();

    const tiktokRow = screen.getByTestId(`channel-row-${connectedAccount.id}`);
    fireEvent.click(within(tiktokRow).getByRole("checkbox", { name: "Select channel" }));
    const youtubeRow = screen.getByTestId(`channel-row-${youtubeAccount.id}`);
    fireEvent.click(within(youtubeRow).getByRole("checkbox", { name: "Select channel" }));
    await expectSelection("2 selected");

    // Hiding a selected channel does not shrink the pill count.
    fireEvent.change(screen.getByLabelText("Search accounts"), {
      target: { value: "tiktok" },
    });
    expect(screen.queryByTestId(`channel-row-${youtubeAccount.id}`)).not.toBeInTheDocument();
    await expectSelection("2 selected");
    expect(
      within(screen.getByTestId(`channel-row-${connectedAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();

    // Clearing the filter restores the hidden row with its selection intact.
    fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "" } });
    expect(
      within(screen.getByTestId(`channel-row-${youtubeAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();
  });

  /**
   * The Brand Profile filter is the mutation scope: switching it clears the
   * selection so ids from another profile can never be bulk-disconnected.
   */
  it("clears the selection when the Brand Profile scope changes", async () => {
    queryResults.platforms.data = [connectedAccount, betaAccount];
    renderChannels();

    fireEvent.click(
      within(screen.getByTestId(`channel-row-${betaAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    );
    await expectSelection("1 selected");

    act(() => {
      workspace.setSelectedBrandProfileId(betaProfile.id);
    });

    await waitFor(() => expect(selectionDock()).toBeNull());
    expect(
      within(screen.getByTestId(`channel-row-${betaAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).not.toBeChecked();
  });

  /**
   * Sequential bulk disconnect keeps failed channels selected while successful
   * ids drop out per-id, and the confirmation only ever mutates the latched
   * snapshot — never the live selection.
   */
  it("retains failed disconnects in the selection after a confirmed batch", async () => {
    queryResults.platforms.data = [connectedAccount, youtubeAccount, betaAccount];
    queryMutations.disconnect.mutateAsync.mockImplementation((id: string) =>
      id === connectedAccount.id ? Promise.resolve() : Promise.reject(new Error("failed")),
    );
    const view = renderChannels();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible channels" }));
    fireEvent.click(bulkActionButton());

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Disconnect 3 channels?",
    });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Disconnect" }));
    });

    expect(queryMutations.disconnect.mutateAsync.mock.calls.map(([id]) => id)).toEqual([
      connectedAccount.id,
      youtubeAccount.id,
      betaAccount.id,
    ]);

    // The successful id left the selection; both failures remain selected.
    await expectSelection("2 selected");
    expect(
      within(screen.getByTestId(`channel-row-${connectedAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).not.toBeChecked();
    expect(
      within(screen.getByTestId(`channel-row-${youtubeAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();
    expect(
      within(screen.getByTestId(`channel-row-${betaAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();

    // A mid-run refetch without the disconnected row cannot drop the failures.
    act(() => {
      queryResults.platforms.data = [youtubeAccount, betaAccount];
      view.rerender(channelsElement());
    });
    expect(
      within(screen.getByTestId(`channel-row-${youtubeAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();

    expect(toastMock).toHaveBeenCalledWith(
      "1 of 3 channels disconnected",
      expect.objectContaining({ variant: "error" }),
    );
  });

  /**
   * The confirmation snapshot protects exactly the selected rows: a bulk run
   * over a single selection issues exactly one mutation for that id.
   */
  it("confirms bulk disconnect against the snapshot only", async () => {
    queryResults.platforms.data = [connectedAccount, youtubeAccount];
    queryMutations.disconnect.mutateAsync.mockResolvedValue(undefined);
    renderChannels();

    fireEvent.click(
      within(screen.getByTestId(`channel-row-${connectedAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    );
    fireEvent.click(bulkActionButton());
    const confirmation = await screen.findByRole("alertdialog", {
      name: "Disconnect 1 channels?",
    });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Disconnect" }));
    });

    expect(queryMutations.disconnect.mutateAsync).toHaveBeenCalledTimes(1);
    expect(queryMutations.disconnect.mutateAsync).toHaveBeenCalledWith(connectedAccount.id);
    await waitFor(() => expect(selectionDock()).toBeNull());
    expect(toastMock).toHaveBeenCalledWith(
      "Channel disconnected",
      expect.objectContaining({ variant: "success" }),
    );
  });

  /**
   * Deselect empties the selection and removes the pill without disconnecting
   * anything.
   */
  it("clears the selection from the pill's Deselect action", async () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible channels" }));
    await expectSelection("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));

    await waitFor(() => expect(selectionDock()).toBeNull());
    expect(queryMutations.disconnect.mutateAsync).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId(`channel-row-${connectedAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).not.toBeChecked();
  });

  /**
   * The channel table is the only projection and keeps the full channel
   * contract: copy controls, Brand Profile ownership, health affordance,
   * settings dialog, and selection.
   */
  it("renders table rows with copy, health, profile, settings, and selection", () => {
    queryResults.platforms.data = [{ ...connectedAccount, username: "alpha_tt" }];
    renderChannels();

    const row = screen.getByTestId(`channel-row-${connectedAccount.id}`);
    expect(within(row).getByRole("checkbox", { name: "Select channel" })).toBeVisible();
    expect(within(row).getByRole("button", { name: "Copy username" })).toBeVisible();
    expect(within(row).getByRole("button", { name: "Copy channel ID" })).toBeVisible();
    expect(within(row).getByText("Alpha Brand")).toBeVisible();
    expect(within(row).getByRole("button", { name: "connected" })).toBeVisible();
    expect(within(row).getByRole("button", { name: "Channel settings" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Select all visible channels" })).toBeVisible();
  });
});
