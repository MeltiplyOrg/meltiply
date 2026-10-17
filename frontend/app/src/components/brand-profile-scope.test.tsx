// @vitest-environment jsdom
import { useEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type * as I18nModule from "@/lib/i18n";
import type {
  Asset,
  BrandProfile,
  CalendarEvent,
  Distribution,
  PlatformAccount,
  Post,
} from "@/types";

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
  disconnect: { mutateAsync: vi.fn() },
  oauth: { mutateAsync: vi.fn() },
  update: { error: null, mutate: vi.fn() },
  cancelDistribution: { isPending: false, mutateAsync: vi.fn() },
  deletePost: { isPending: false, mutateAsync: vi.fn() },
  retryDistribution: { isPending: false, mutateAsync: vi.fn() },
  updateScheduledDistribution: { isPending: false, mutateAsync: vi.fn() },
}));

const queryResults = vi.hoisted(() => ({
  capabilities: {
    data: [
      {
        analytics: false,
        comments: false,
        platform: "tiktok",
        publish: false,
        reply: false,
      },
    ],
    error: null,
  },
  platforms: {
    data: [] as PlatformAccount[],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
  posts: {
    data: { posts: [] as Post[], has_more: false, limit: 100, offset: 0 },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  },
  calendar: { data: [] as CalendarEvent[], error: null, isLoading: false, refetch: vi.fn() },
  asset: { data: undefined as Asset | undefined, error: null, isLoading: false },
}));

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
    return { ...workspace, logout: vi.fn() };
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
  useAsset: () => queryResults.asset,
  useCalendar: () => queryResults.calendar,
  useCancelDistribution: () => queryMutations.cancelDistribution,
  useDeletePost: () => queryMutations.deletePost,
  usePost: () => ({ data: undefined as Post | undefined, error: null, isLoading: false }),
  usePosts: () => queryResults.posts,
  useRetryDistribution: () => queryMutations.retryDistribution,
  useUpdateScheduledDistribution: () => queryMutations.updateScheduledDistribution,
}));

vi.mock("@meltiply/ui/sidebar-glide-highlight", () => ({
  SidebarGlideHighlight: () => null,
}));
import { ChannelsView } from "./channels/channels-view";
import { PostsView } from "./posts/posts-view";

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

const expiredAccount: PlatformAccount = {
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

/**
 * Published Post built from the contract fixtures: an active composition whose
 * sole Channel claimed a frozen publication, so every Posts surface projects a
 * real published row. `published_at` is stamped at render time so the row
 * always lands inside the calendar month under test.
 */
const publishedPost: Post = {
  ...contractSuccessBody<Post>("getPost"),
  brand_profile_id: alphaProfile.id,
  status: "active",
  distributions: [
    {
      ...contractSuccessBody<Distribution>("getDistribution"),
      brand_profile_id: alphaProfile.id,
      scheduled_at: null,
      published_at: null,
    },
  ],
};

/** Calendar event for the published Post, folded back onto its `post_id`. */
const publishedEvent: CalendarEvent = {
  ...contractSuccessBody<{ events: CalendarEvent[] }>("listCalendarEvents").events[0]!,
  brand_profile_id: alphaProfile.id,
  status: "published",
};

/** Resets mocked workspace and query state so each rendered surface starts independent. */
function resetScope() {
  workspace.brandProfiles = [alphaProfile];
  workspace.channelStatuses = [];
  workspace.integrations = [];
  workspace.isAdmin = true;
  workspace.selectedBrandProfile = null;
  workspace.selectedBrandProfileId = null;
  workspace.selectedPlatforms = [];
  workspace.setSelectedBrandProfileId.mockClear();
  workspace.setSelectedPlatforms.mockClear();
  queryMutations.create.mutate.mockReset();
  queryMutations.delete.mutate.mockReset();
  queryMutations.disconnect.mutateAsync.mockReset();
  queryMutations.oauth.mutateAsync.mockReset();
  queryMutations.update.mutate.mockReset();
  queryResults.platforms.data = [];
  queryResults.platforms.refetch.mockReset();
  queryMutations.cancelDistribution.mutateAsync.mockReset();
  queryMutations.deletePost.mutateAsync.mockReset();
  queryMutations.retryDistribution.mutateAsync.mockReset();
  queryMutations.updateScheduledDistribution.mutateAsync.mockReset();
  queryResults.posts.data = { posts: [], has_more: false, limit: 100, offset: 0 };
  queryResults.calendar.data = [];
}

/**
 * Renders the channels view inside a router context.
 *
 * The view reads router search params for its initial tab, so a `MemoryRouter`
 * is required even though navigation itself is mocked.
 */
function renderChannels() {
  return render(
    <MemoryRouter>
      <ChannelsView />
    </MemoryRouter>,
  );
}

/** Opens the field-row builder and adds the supported channel filters through its visible chips. */
function openChannelFilters() {
  fireEvent.click(screen.getByText("Filter").closest("summary")!);
  for (const label of ["Platform", "Brand Profile"]) {
    const add = screen.queryByRole("button", { name: `Add ${label} filter` });
    if (add) fireEvent.click(add);
  }
}

/**
 * Renders the posts view inside a router context at the requested mode, with a
 * profile selected so channel mutations stay affordanced.
 */
function renderPosts(initialViewMode: "table" | "grid" | "calendar" = "table") {
  workspace.selectedBrandProfile = alphaProfile;
  workspace.selectedBrandProfileId = alphaProfile.id;
  return render(
    <MemoryRouter>
      <PostsView initialViewMode={initialViewMode} />
    </MemoryRouter>,
  );
}

/**
 * Loads the published contract Post into the mocked posts and calendar queries
 * so list, grid, and calendar surfaces all project the same row.
 */
function seedPublishedPost() {
  const publishedAt = new Date().toISOString();
  const post: Post = {
    ...publishedPost,
    updated_at: publishedAt,
    distributions: [
      { ...publishedPost.distributions[0]!, published_at: publishedAt, updated_at: publishedAt },
    ],
  };
  queryResults.posts.data = {
    posts: [post],
    has_more: false,
    limit: 100,
    offset: 0,
  };
  queryResults.calendar.data = [
    { ...publishedEvent, published_at: publishedAt, updated_at: publishedAt },
  ];
}

/** Metric column and tile labels no Posts surface may render without a data path. */
const METRIC_LABELS = [
  "Likes",
  "Cmts",
  "Shrs",
  "Saves",
  "Clicks",
  "Views",
  "Impr.",
  "Impressions",
  "Reach",
  "Comments",
  "Analytics",
];

beforeAll(() => {
  // jsdom does not implement scrollIntoView; Radix Select calls it when its
  // popover content mounts and focuses the selected item.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-low-motion");
});
beforeEach(() => {
  // jsdom never settles the bulk pill's motion transitions; the real low-motion
  // attribute makes entrance/exit instant instead of mocking components.
  document.documentElement.setAttribute("data-low-motion", "");
  resetScope();
});

describe("Channels table contract", () => {
  /**
   * Bulk disconnect snapshots the selected table rows and retains failures, so
   * retrying never disconnects an already-successful account again.
   */
  it("retains only failed channels after confirmed bulk disconnect", async () => {
    queryResults.platforms.data = [connectedAccount, expiredAccount];
    queryMutations.disconnect.mutateAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    renderChannels();

    fireEvent.click(
      within(screen.getByTestId(`channel-row-${connectedAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    );
    fireEvent.click(
      within(screen.getByTestId(`channel-row-${expiredAccount.id}`)).getByRole("checkbox", {
        name: "Select channel",
      }),
    );
    await screen.findByRole("region", { name: "Selection actions" });
    expect(
      within(screen.getByRole("row", { name: /Alpha TikTok/ })).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();
    expect(
      within(screen.getByRole("row", { name: /Alpha YouTube/ })).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();

    fireEvent.click(
      within(screen.getByRole("region", { name: "Selection actions" })).getByRole("button", {
        name: "Disconnect",
      }),
    );
    expect(queryMutations.disconnect.mutateAsync).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
      );
    });

    expect(queryMutations.disconnect.mutateAsync.mock.calls.map(([id]) => id)).toEqual([
      connectedAccount.id,
      expiredAccount.id,
    ]);
    expect(
      within(screen.getByRole("row", { name: /Alpha TikTok/ })).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).not.toBeChecked();
    expect(
      within(screen.getByRole("row", { name: /Alpha YouTube/ })).getByRole("checkbox", {
        name: "Select channel",
      }),
    ).toBeChecked();
    expect(screen.getByRole("region", { name: "Selection actions" })).toHaveTextContent(
      "1 selected",
    );
  });

  /** Channel settings expose granted scopes and require confirmation before disconnecting. */
  it("reveals permissions and confirms disconnect from channel settings", async () => {
    queryResults.platforms.data = [{ ...connectedAccount, scopes: ["video.upload"] }];
    renderChannels();
    fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
    const dialog = screen.getByRole("dialog", { name: connectedAccount.display_name! });
    expect(within(dialog).getByText("video.upload")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(queryMutations.disconnect.mutateAsync).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Disconnect" }));
    });
    expect(queryMutations.disconnect.mutateAsync).toHaveBeenCalledWith(connectedAccount.id);
  });

  /**
   * An empty workspace keeps filters and both creation actions in the header.
   * Connection stays blocked until profile creation; Reset clears typed search.
   */
  it("disables Add account without Brand Profiles and opens in-place profile creation", () => {
    workspace.brandProfiles = [];
    renderChannels();

    expect(screen.getByText("No channels connected yet")).toBeVisible();
    const search = screen.getByLabelText("Search accounts");
    expect(search).toBeVisible();
    fireEvent.change(search, { target: { value: "nothing connected" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("button", { name: "Add account" })).toBeDisabled();
    expect(header.getByRole("button", { name: "Create Brand Profile" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(1);
    expect(screen.getByText("Create a Brand Profile before connecting accounts.")).toBeVisible();

    fireEvent.click(header.getByRole("button", { name: "Create Brand Profile" }));

    const dialog = screen.getByRole("dialog", { name: "Create Brand Profile" });
    expect(within(dialog).getByLabelText("Profile name")).toBeVisible();
    expect(
      within(dialog).getByRole("radiogroup", { name: "Choose a profile color" }),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Create profile" })).toBeDisabled();
  });

  it("directs non-admin members to a workspace admin when no profile exists", () => {
    workspace.brandProfiles = [];
    workspace.isAdmin = false;
    renderChannels();

    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create Brand Profile" })).not.toBeInTheDocument();
    expect(screen.getByText("Ask a workspace admin to create a Brand Profile.")).toBeVisible();
  });

  it("directs non-admin members to a workspace admin from the channel directory", () => {
    workspace.brandProfiles = [];
    workspace.isAdmin = false;
    renderChannels();

    expect(screen.queryByRole("button", { name: /Add Channels/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
    expect(screen.getByText("Ask a workspace admin to create a Brand Profile.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create Brand Profile" })).not.toBeInTheDocument();
  });

  it("creates a Brand Profile in place and selects it for the platform directory", () => {
    workspace.brandProfiles = [];
    renderChannels();

    fireEvent.click(screen.getByRole("button", { name: "Create Brand Profile" }));
    const dialog = screen.getByRole("dialog", { name: "Create Brand Profile" });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Beta Brand" },
    });
    fireEvent.change(within(dialog).getByLabelText("Profile description"), {
      target: { value: "Publisher tools and workflows." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));

    expect(queryMutations.create.mutate).toHaveBeenCalledWith(
      {
        name: "Beta Brand",
        description: "Publisher tools and workflows.",
        color: "#b91c1c",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const [, options] = queryMutations.create.mutate.mock.calls[0]!;
    act(() => options.onSuccess(betaProfile));

    expect(workspace.setSelectedBrandProfileId).toHaveBeenCalledWith(betaProfile.id);
    const connectDialog = screen.getByRole("dialog", { name: "Connect social account" });
    expect(connectDialog).toBeVisible();
    expect(within(connectDialog).getByPlaceholderText("Search platforms…")).toBeVisible();
  });

  it("submits the entered name and chosen beehive color when creating a profile from channels", () => {
    workspace.brandProfiles = [];
    renderChannels();

    fireEvent.click(screen.getByRole("button", { name: "Create Brand Profile" }));
    const dialog = screen.getByRole("dialog", { name: "Create Brand Profile" });

    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Delta Brand" },
    });

    // Select a color from the honeycomb beehive
    const colorNode = within(dialog).getByRole("radio", { name: "#0369a1" });
    fireEvent.click(colorNode);

    fireEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));

    expect(queryMutations.create.mutate).toHaveBeenCalledWith(
      { name: "Delta Brand", description: null, color: "#0369a1" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  /**
   * Guards the WAI-ARIA radio-group contract in the beehive picker: arrow,
   * Home, and End keys must move DOM focus to the newly checked swatch so
   * focus can never strand on the previously selected radio.
   */
  it("moves focus to the newly selected swatch on arrow, Home, and End keys", () => {
    renderChannels();

    fireEvent.click(screen.getByRole("button", { name: "Create Brand Profile" }));
    const dialog = screen.getByRole("dialog", { name: "Create Brand Profile" });

    const firstSwatch = within(dialog).getByRole("radio", { name: "#b91c1c" });
    firstSwatch.focus();

    fireEvent.keyDown(firstSwatch, { key: "ArrowRight" });
    const nextSwatch = within(dialog).getByRole("radio", { name: "#991b1b" });
    expect(nextSwatch).toHaveFocus();
    expect(nextSwatch).toHaveAttribute("aria-checked", "true");
    expect(firstSwatch).not.toHaveFocus();

    fireEvent.keyDown(nextSwatch, { key: "End" });
    const lastSwatch = within(dialog).getByRole("radio", { name: "#111827" });
    expect(lastSwatch).toHaveFocus();
    expect(lastSwatch).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(lastSwatch, { key: "Home" });
    expect(firstSwatch).toHaveFocus();
    expect(firstSwatch).toHaveAttribute("aria-checked", "true");
  });

  /**
   * Confirms the color picker swatch cells omit rectangular hover backgrounds
   * and rely solely on scale transformation (hover:scale-110) for hover feedback.
   */
  it("omits rectangular button backgrounds on hover of the color picker cells", () => {
    renderChannels();

    fireEvent.click(screen.getByRole("button", { name: "Create Brand Profile" }));
    const dialog = screen.getByRole("dialog", { name: "Create Brand Profile" });

    const unselectedSwatch = within(dialog).getByRole("radio", { name: "#991b1b" });
    expect(unselectedSwatch).toHaveClass("hover:bg-transparent");
    expect(unselectedSwatch).toHaveClass("hover:scale-110");
    expect(unselectedSwatch).not.toHaveClass("hover:bg-muted");
  });

  it("enables Add account with a Brand Profile and opens the platform directory", () => {
    renderChannels();

    const addAccount = screen.getByRole("button", { name: "Add account" });
    expect(addAccount).toBeEnabled();
    fireEvent.click(addAccount);

    const connectDialog = screen.getByRole("dialog", { name: "Connect social account" });
    expect(connectDialog).toBeVisible();
    expect(within(connectDialog).getByPlaceholderText("Search platforms…")).toBeVisible();
    expect(within(connectDialog).getByRole("combobox", { name: "Brand Profile" })).toBeVisible();
  });

  /**
   * With profiles but zero connected accounts, Add account remains a single
   * enabled header action and opens the connection dialog from that fixed location.
   */
  it("presents a single usable Add account action when profiles exist without accounts", () => {
    renderChannels();

    expect(screen.getByText("No channels connected yet")).toBeVisible();
    const addAccountActions = screen.getAllByRole("button", { name: "Add account" });
    expect(addAccountActions).toHaveLength(1);
    expect(addAccountActions[0]).toBeEnabled();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Add account" })).toBe(
      addAccountActions[0],
    );

    fireEvent.click(addAccountActions[0]!);

    expect(screen.getByRole("dialog", { name: "Connect social account" })).toBeVisible();
  });

  /**
   * Reproduces the empty-directory profile edit path: the card action must open
   * the same dialog exposing edit and deletion before any accounts are connected.
   */
  it("opens the profile editor from the empty Channels directory action", () => {
    workspace.selectedBrandProfile = alphaProfile;
    workspace.selectedBrandProfileId = alphaProfile.id;
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: alphaProfile.name }));
    const editProfileButton = screen.getByRole("button", { name: "Edit profile" });
    fireEvent.pointerDown(editProfileButton);
    fireEvent.click(editProfileButton);

    const dialog = screen.getByRole("dialog", { name: "Update Brand Profile" });
    expect(within(dialog).getByLabelText("Profile name")).toHaveValue(alphaProfile.name);
    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeVisible();
  });

  /**
   * Guards the confirmation requirement: cancelling the AlertDialog must leave
   * the editor open and must not invoke the delete mutation.
   */
  it("does not delete when cancelling the delete confirmation dialog", async () => {
    workspace.selectedBrandProfile = alphaProfile;
    workspace.selectedBrandProfileId = alphaProfile.id;
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: alphaProfile.name }));
    const editProfileButton = screen.getByRole("button", { name: "Edit profile" });
    fireEvent.pointerDown(editProfileButton);
    fireEvent.click(editProfileButton);

    const dialog = screen.getByRole("dialog", { name: "Update Brand Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete Brand Profile",
    });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    });

    expect(queryMutations.delete.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Update Brand Profile" })).toBeVisible();
  });

  /**
   * Confirms the AlertDialog flow: the editor's delete button only opens the
   * confirmation, and its Delete action executes the mutation.
   */
  it("deletes the profile after confirming the delete dialog in the profile editor", async () => {
    workspace.selectedBrandProfile = alphaProfile;
    workspace.selectedBrandProfileId = alphaProfile.id;
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: alphaProfile.name }));
    const editProfileButton = screen.getByRole("button", { name: "Edit profile" });
    fireEvent.pointerDown(editProfileButton);
    fireEvent.click(editProfileButton);

    const dialog = screen.getByRole("dialog", { name: "Update Brand Profile" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    expect(queryMutations.delete.mutate).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete Brand Profile",
    });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
    });

    expect(queryMutations.delete.mutate).toHaveBeenCalledWith(
      alphaProfile.id,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  /** Toolbar editing preserves the selected profile while saving its changed name. */
  it("edits a profile from the toolbar editor", () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

    const dialog = screen.getByRole("dialog", { name: /(?:Edit|Update) Brand Profile/ });
    expect(within(dialog).getByLabelText("Profile name")).toHaveValue("Alpha Brand");
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Renamed Brand" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /(?:Save changes|Update profile)/ }),
    );

    expect(queryMutations.update.mutate).toHaveBeenCalledWith(
      {
        profileId: alphaProfile.id,
        input: {
          name: "Renamed Brand",
          description: alphaProfile.description,
          color: "#b91c1c",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  /**
   * Guards the edit-mode contract: saving an existing Brand Profile must not
   * chain into the connect-account flow — that hand-off is reserved for fresh
   * profile creation — and must leave the active workspace filter selection
   * untouched, so the editor simply closes after a successful update.
   */
  it("does not open the connect-account dialog after editing a profile", () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

    const dialog = screen.getByRole("dialog", { name: /(?:Edit|Update) Brand Profile/ });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Renamed Brand" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /(?:Save changes|Update profile)/ }),
    );

    const [, options] = queryMutations.update.mutate.mock.calls[0]!;
    act(() => options.onSuccess({ ...alphaProfile, name: "Renamed Brand" }));

    expect(workspace.setSelectedBrandProfileId).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Connect social account" }),
    ).not.toBeInTheDocument();
  });

  /**
   * Guards the admin-only edit affordance in the Channels toolbar: non-admin
   * members get no edit callback, so profile rows render as plain selectable
   * options that keep the standard selected checkmark instead of reserving
   * space for a pencil that could never fire.
   */
  it("hides the profile edit pencil and keeps selection indicators for non-admins", () => {
    workspace.isAdmin = false;
    workspace.selectedBrandProfileId = alphaProfile.id;
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: "Alpha Brand" }));

    expect(screen.queryByRole("button", { name: "Edit profile" })).not.toBeInTheDocument();
    const selectedOption = screen.getByRole("option", { name: "Alpha Brand" });
    expect(selectedOption).toHaveAttribute("data-state", "checked");
    expect(selectedOption.querySelector("svg")).not.toBeNull();
  });

  /**
   * Guards the admin affordance in the Channels toolbar: admins receive the
   * edit callback, so resolved profile rows expose the pencil that opens the
   * in-place Brand Profile editor.
   */
  it("shows the profile edit pencil for admins", () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));

    expect(screen.getByRole("button", { name: "Edit profile" })).toBeVisible();
  });

  /**
   * Guards the edit-affordance dismissal contract: the pencil sits outside the
   * option element, so Radix never closes the menu on its own — the select must
   * close its dropdown before the editor opens, leaving no listbox behind it.
   */
  it("closes the profile dropdown before opening the editor from the pencil", () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    openChannelFilters();
    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
    expect(screen.getByRole("listbox")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /(?:Edit|Update) Brand Profile/ })).toBeVisible();
    expect(workspace.setSelectedBrandProfileId).not.toHaveBeenCalled();
  });

  /**
   * Confirms profile deletion from the Brand Profile editor confirmation flow.
   */
  it("confirms profile deletion from the Brand Profile editor delete confirmation", async () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

    const dialog = screen.getByRole("dialog", { name: /(?:Edit|Update) Brand Profile/ });
    const deleteButton = within(dialog).getByRole("button", { name: "Delete profile" });
    expect(deleteButton).toBeVisible();

    fireEvent.click(deleteButton);

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete Brand Profile",
    });
    await act(async () => {
      fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
    });

    expect(queryMutations.delete.mutate).toHaveBeenCalledWith(
      alphaProfile.id,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  /**
   * Guards the permanent-deletion failure path: a rejected mutation surfaces an
   * inline error alert while the editor dialog stays mounted and retryable.
   */
  it("reports deletion failure and keeps the editor dialog retryable", async () => {
    try {
      queryResults.platforms.data = [connectedAccount];
      renderChannels();

      fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));

      const dialog = screen.getByRole("dialog", { name: /(?:Edit|Update) Brand Profile/ });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));

      let confirmation = await screen.findByRole("alertdialog", {
        name: "Delete Brand Profile",
      });
      await act(async () => {
        fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
      });

      expect(queryMutations.delete.mutate).toHaveBeenCalledTimes(1);

      queryMutations.delete.error = new Error("delete failed");
      const [, options] = queryMutations.delete.mutate.mock.calls[0]!;
      act(() => {
        options.onError?.(new Error("delete failed"));
      });

      expect(dialog).toBeVisible();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));

      confirmation = await screen.findByRole("alertdialog", { name: "Delete Brand Profile" });
      await act(async () => {
        fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
      });

      expect(queryMutations.delete.mutate).toHaveBeenCalledTimes(2);
    } finally {
      queryMutations.delete.error = null;
    }
  });
  /**
   * Ensures focused controls filter independent table rows while
   * retaining their accessible control identity through label transitions.
   */
  it("renders focused channel controls and narrows connected channel rows with each filter", () => {
    workspace.brandProfiles = [alphaProfile, betaProfile];
    queryResults.platforms.data = [connectedAccount, expiredAccount, betaAccount];
    renderChannels();
    openChannelFilters();

    expect(screen.getByLabelText("Search accounts")).toBeVisible();
    const platformControl = screen.getByRole("button", { name: "All platforms" });
    const profileControl = screen.getByRole("combobox", { name: "All Brand Profiles" });
    const statusControl = screen.getByRole("group", { name: "Connection status" });
    expect(platformControl).toBeVisible();
    expect(profileControl).toBeVisible();
    expect(statusControl).toBeVisible();

    expect(screen.queryByText(/^\d+ channels connected$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ \/ \d+ channels$/)).not.toBeInTheDocument();

    const alphaTikTokRow = screen.getByTestId(`channel-row-${connectedAccount.id}`);
    const alphaYouTubeRow = screen.getByTestId(`channel-row-${expiredAccount.id}`);
    const betaInstagramRow = screen.getByTestId(`channel-row-${betaAccount.id}`);
    expect(alphaTikTokRow).toBeVisible();
    expect(alphaYouTubeRow).toBeVisible();
    expect(betaInstagramRow).toBeVisible();

    expect(screen.getByText("Alpha TikTok")).toBeVisible();
    expect(screen.getByText("Alpha YouTube")).toBeVisible();
    expect(screen.getByText("Beta Instagram")).toBeVisible();

    // Keyword filter matches the account display name.
    fireEvent.change(screen.getByLabelText("Search accounts"), {
      target: { value: "YouTube" },
    });
    expect(screen.getByText("Alpha YouTube")).toBeVisible();
    expect(screen.queryByText("Alpha TikTok")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta Instagram")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "" } });

    // Platform filter narrows to a single provider; the trigger's accessible
    // name tracks the visible selection text instead of a static field label.
    fireEvent.pointerDown(platformControl);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Instagram" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Instagram" })).toBe(platformControl);
    expect(screen.getByText("Beta Instagram")).toBeVisible();
    expect(screen.queryByText("Alpha TikTok")).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha YouTube")).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Instagram" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All platforms" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("button", { name: "All platforms" })).toBe(platformControl);
    // Brand Profile filter narrows to accounts owned by that profile.
    fireEvent.click(screen.getByRole("combobox", { name: "All Brand Profiles" }));
    fireEvent.click(screen.getByRole("option", { name: "Beta Brand" }));
    expect(screen.getByRole("combobox", { name: "Beta Brand" })).toHaveTextContent("Beta Brand");
    expect(screen.getByRole("combobox", { name: "Beta Brand" })).toBe(profileControl);
    expect(screen.queryByText("Alpha TikTok")).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha YouTube")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Beta Brand" }));
    fireEvent.click(screen.getByRole("option", { name: "All Brand Profiles" }));
    expect(screen.getByRole("combobox", { name: "All Brand Profiles" })).toHaveTextContent(
      "All Brand Profiles",
    );
    expect(screen.getByRole("combobox", { name: "All Brand Profiles" })).toBe(profileControl);
    fireEvent.click(within(statusControl).getByRole("button", { name: /^expired$/i }));
    expect(screen.getByText("Alpha YouTube")).toBeVisible();
    expect(screen.queryByText("Alpha TikTok")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta Instagram")).not.toBeInTheDocument();
  });

  /**
   * Guards the platform filter's accessible contract: it is a multi-select
   * checkbox menu, not a single-choice combobox, so the trigger stays a button
   * named by its visible selection, every canonical `PLATFORM_IDS` option keeps
   * the menuitemcheckbox role with an observable checked state, and the menu
   * stays open across toggles for multi-pick workflows.
   */
  it("keeps checkbox-menu semantics in the platform multi-select", () => {
    queryResults.platforms.data = [connectedAccount, betaAccount];
    renderChannels();
    openChannelFilters();

    const platformFilter = screen.getByRole("button", { name: "All platforms" });
    fireEvent.pointerDown(platformFilter);

    // Radix names the opened menu from its trigger via aria-labelledby.
    expect(screen.getByRole("menu", { name: "All platforms" })).toBeVisible();
    expect(screen.getByRole("menuitemcheckbox", { name: "All platforms" })).toBeChecked();
    for (const name of ["TikTok", "YouTube", "Instagram", "Facebook", "Threads"]) {
      expect(screen.getByRole("menuitemcheckbox", { name })).not.toBeChecked();
    }

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Instagram" }));

    expect(screen.getByRole("menuitemcheckbox", { name: "Instagram" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "All platforms" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "TikTok" }));

    expect(screen.getByRole("menuitemcheckbox", { name: "TikTok" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "Instagram" })).toBeChecked();

    // Closing and reopening preserves the trigger and checked menu choices,
    // independently of the translated count label.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(platformFilter).toBeVisible();
    expect(platformFilter).toHaveAttribute("aria-expanded", "false");

    fireEvent.pointerDown(platformFilter);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All platforms" }));

    expect(screen.getByRole("menuitemcheckbox", { name: "All platforms" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "TikTok" })).not.toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "Instagram" })).not.toBeChecked();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("button", { name: "All platforms" })).toBeVisible();
  });

  it("displays the filtered-empty message and clears filters", () => {
    queryResults.platforms.data = [connectedAccount];
    renderChannels();

    fireEvent.change(screen.getByLabelText("Search accounts"), {
      target: { value: "no such account" },
    });

    expect(screen.getByText("No accounts match the active filters.")).toBeVisible();
    expect(screen.queryByText("Alpha TikTok")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByText("Alpha TikTok")).toBeVisible();
    expect(screen.getByLabelText("Search accounts")).toHaveValue("");
  });
});

describe("Posts surfaces", () => {
  /**
   * Aggregate bulk deletion uses each Post's owning profile, waits for confirmation,
   * and retains only failed identities rather than retrying successful deletions.
   */
  it("deletes selected posts with their owning profiles and retains partial failures", async () => {
    const first: Post = {
      ...publishedPost,
      status: "draft",
      distributions: [],
      default_text: "First bulk post",
    };
    const second: Post = {
      ...first,
      id: "00000000-0000-4000-8000-000000000099",
      brand_profile_id: betaProfile.id,
      default_text: "Second bulk post",
    };
    workspace.brandProfiles = [alphaProfile, betaProfile];
    queryResults.posts.data = { posts: [first, second], has_more: false, limit: 100, offset: 0 };
    queryMutations.deletePost.mutateAsync
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Delete failed"));
    render(
      <MemoryRouter>
        <PostsView />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible posts" }));
    const pill = await screen.findByRole("region", { name: "Selection actions" });
    fireEvent.click(within(pill).getByRole("button", { name: "Delete" }));
    expect(queryMutations.deletePost.mutateAsync).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Delete",
        }),
      );
    });

    expect(queryMutations.deletePost.mutateAsync.mock.calls.map(([input]) => input)).toEqual([
      { id: first.id, brandProfileId: first.brand_profile_id },
      { id: second.id, brandProfileId: second.brand_profile_id },
    ]);
    expect(screen.getByRole("region", { name: "Selection actions" })).toHaveTextContent(
      "1 selected",
    );
    const rows = screen.getAllByRole("checkbox", { name: "Select post" });
    expect(rows.filter((row) => (row as HTMLInputElement).checked)).toHaveLength(1);
  });

  /**
   * Guards the published Post projection: caption, status, and actions remain
   * usable without inventing engagement data that has no supported data path.
   */
  it("renders the published Post without unsupported metrics", () => {
    seedPublishedPost();
    renderPosts();

    const row = screen.getByRole("row", { name: /Launch note/ });
    expect(within(row).getByText("published")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
    for (const label of METRIC_LABELS) {
      expect(
        screen.queryByRole("columnheader", { name: label }),
        `${label} column must not render`,
      ).not.toBeInTheDocument();
      expect(screen.queryByText(label), `${label} must not render`).not.toBeInTheDocument();
    }
  });

  /**
   * Guards the published Post card in grid view: caption, status, and the
   * row-level edit/delete affordances stay while no metric tile renders.
   */
  it("renders the published Post card without metric tiles in grid view", () => {
    seedPublishedPost();
    renderPosts("grid");

    expect(screen.getByText("Launch note")).toBeVisible();
    expect(screen.getByText("published")).toBeVisible();
    for (const label of METRIC_LABELS) {
      expect(screen.queryByText(label), `${label} must not render`).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Edit post" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete post" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create post" })).toBeVisible();
  });

  /**
   * Guards the calendar surface and its day-detail dialog: the folded Post
   * chip keeps status, caption, and day actions while no metric tile renders.
   */
  it("renders the calendar day dialog without metric tiles", () => {
    seedPublishedPost();
    renderPosts("calendar");

    fireEvent.click(
      screen.getByRole("button", {
        name: `View posts on ${new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(new Date())}`,
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Launch note")).toBeVisible();
    expect(within(dialog).getByText("published")).toBeVisible();
    for (const label of METRIC_LABELS) {
      expect(within(dialog).queryByText(label), `${label} must not render`).not.toBeInTheDocument();
    }
    expect(within(dialog).getByRole("button", { name: "Details" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeVisible();
  });
});
