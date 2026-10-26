// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AnalyticsView } from "./analytics-view";
import type { AnalyticsSummary, PlatformMetrics } from "@/types";

const navigate = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());
const setSelectedBrandProfileId = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => ({
  accounts: vi.fn(),
  capabilities: vi.fn(),
  posts: vi.fn(),
  dashboard: vi.fn(),
  summary: vi.fn(),
}));

const state = vi.hoisted(() => ({
  selectedBrandProfileId: null as string | null,
  accounts: { data: [] as unknown[], error: null as Error | null, isPending: false },
  capabilities: { data: [] as unknown[], error: null as Error | null, isPending: false },
  dashboard: {
    data: undefined as unknown,
    error: null as Error | null,
    isFetching: false,
    isPending: false,
  },
  posts: {
    data: undefined as unknown,
    error: null as Error | null,
    isFetching: false,
    isPending: false,
  },
  searchParams: new URLSearchParams(),
  summary: {
    data: undefined as unknown,
    error: null as Error | null,
    isFetching: false,
    isPending: false,
  },
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/lib/navigation", () => ({
  usePathname: () => "/analytics",
  useSearchParams: () => state.searchParams,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({
    brandProfileId: state.selectedBrandProfileId,
    isSignedIn: true,
    workspaceId: "workspace-1",
  }),
}));
vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => ({
    brandProfiles: [],
    selectedBrandProfile: null,
    selectedBrandProfileId: state.selectedBrandProfileId,
    setSelectedBrandProfileId,
  }),
}));
vi.mock("@/lib/queries", () => ({
  usePlatformCapabilities: () => ({ ...state.capabilities, refetch: refetch.capabilities }),
  usePlatforms: () => ({ ...state.accounts, refetch: refetch.accounts }),
  useAnalyticsDashboard: () => ({
    ...state.dashboard,
    data: state.dashboard.data
      ? { ...(state.dashboard.data as Record<string, unknown>), cohort: state.summary.data }
      : state.dashboard.data,
    refetch: refetch.dashboard,
  }),
  useAnalyticsPosts: () => ({ ...state.posts, refetch: refetch.posts }),
}));

beforeAll(() => {
  class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

function capability(platform: string, analytics: boolean) {
  return {
    accepted_mime_types: [],
    analytics,
    asset_types: [],
    comments: false,
    connect_available: true,
    max_caption_length: null,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: null,
    multi_asset_types: null,
    notes: [],
    platform,
    publish: true,
    reply: false,
  };
}

function platformRow(overrides: Partial<PlatformMetrics> = {}): PlatformMetrics {
  return {
    comments: 1,
    impressions: 0,
    last_synced_at: "2026-10-30T12:00:00Z",
    likes: 5,
    platform: "instagram",
    post_count: 1,
    reach: 0,
    shares: 1,
    views: 300,
    watch_time_sec: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    by_platform: [platformRow()],
    last_synced_at: "2026-10-30T12:00:00Z",
    partial: false,
    range: { end: "2026-10-30T12:00:00Z", start: "2026-09-30T12:00:00Z" },
    totals: {
      comments: 1,
      impressions: 0,
      likes: 5,
      post_count: 1,
      reach: 0,
      shares: 1,
      views: 300,
      watch_time_sec: 0,
    },
    unsupported_platforms: [],
    ...overrides,
  };
}

function dashboardFixture() {
  return {
    range: { start: "2026-09-30T12:00:00Z", end: "2026-10-30T12:00:00Z" },
    series: [
      {
        date: "2026-10-18",
        platform: "instagram",
        posts: 1,
        views: 300,
        likes: 10,
        comments: 2,
        shares: 1,
        impressions: 0,
        reach: 0,
        last_synced_at: "2026-10-30T12:00:00Z",
      },
    ],
    best_times: [
      {
        day_of_week: 1,
        hour: 12,
        posts: 2,
        avg_views: 300,
        avg_likes: 10,
        avg_comments: 2,
        avg_shares: 1,
        avg_engagement: 13,
      },
    ],
    formats: [
      {
        format: "text",
        posts: 1,
        views: 300,
        likes: 10,
        comments: 2,
        shares: 1,
        engagement: 13,
        avg_views: 300,
        avg_engagement: 13,
        last_synced_at: "2026-10-30T12:00:00Z",
      },
    ],
    platforms: [
      {
        platform: "instagram",
        posts: 1,
        views: 300,
        likes: 10,
        comments: 2,
        shares: 1,
        impressions: 0,
        reach: 0,
        engagement_rate: 0.043,
        followers: 12400,
        follower_gain: 42,
        saves: null,
        clicks: null,
        last_synced_at: "2026-10-30T12:00:00Z",
      },
    ],
    followers: [
      {
        platform: "instagram",
        account_id: "e3000000-0000-4000-8000-000000000007",
        account_name: "Alpha IG",
        points: [{ captured_at: "2026-10-30T12:00:00Z", followers: 12400 }],
      },
    ],
    accumulation: [{ elapsed_hours: 24, avg_engagement: 13, observations: 1 }],
    unavailable_metrics: ["saves", "clicks"],
  };
}

function posts(overrides: Record<string, unknown> = {}) {
  return {
    has_more: false,
    limit: 10,
    offset: 0,
    posts: [
      {
        comments: 1,
        destination_count: 1,
        synced_destination_count: 1,
        excerpt: "Excerpt",
        last_synced_at: "2026-10-30T12:00:00Z",
        likes: 5,
        platforms: ["instagram"],
        post_id: "post-1",
        published_at: "2026-10-18T12:00:00Z",
        shares: 1,
        title: "Launch notes",
        unsupported_platforms: [],
        views: 300,
      },
    ],
    ...overrides,
  };
}

function connectedAccount(platform: string) {
  return { connection_status: "connected", platform };
}

function renderView() {
  return render(
    <MemoryRouter>
      <AnalyticsView />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.selectedBrandProfileId = null;
  setSelectedBrandProfileId.mockReset();
  state.searchParams = new URLSearchParams();
  state.capabilities = {
    data: [capability("instagram", true), capability("threads", true)],
    error: null,
    isPending: false,
  };
  state.accounts = {
    data: [connectedAccount("instagram")],
    error: null,
    isPending: false,
  };
  state.dashboard = { data: dashboardFixture(), error: null, isFetching: false, isPending: false };
  state.summary = { data: summary(), error: null, isFetching: false, isPending: false };
  state.posts = { data: posts(), error: null, isFetching: false, isPending: false };
  navigate.mockReset();
  invalidateQueries.mockReset();
  Object.values(refetch).forEach((mock) => mock.mockReset());
});

afterEach(() => {
  cleanup();
});

describe("analytics view", () => {
  it("keeps profile clearing available when that profile has no capable channels", () => {
    state.selectedBrandProfileId = "empty-profile";
    state.accounts.data = [];
    renderView();
    expect(
      screen.getByText("Analytics needs a connected channel that reports analytics."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear Unknown profile filter" }));
    expect(setSelectedBrandProfileId).toHaveBeenCalledWith(null);
  });

  it("clears the profile and URL filters atomically while preserving the ranking metric", () => {
    state.selectedBrandProfileId = "profile-1";
    state.searchParams = new URLSearchParams(
      "account=e3000000-0000-4000-8000-000000000002&format=video&platform=instagram&range=7d&metric=likes",
    );
    renderView();
    fireEvent.click(screen.getByTitle("Reset filters"));
    expect(setSelectedBrandProfileId).toHaveBeenCalledWith(null);
    expect(navigate).toHaveBeenCalledOnce();
    const query = new URL(navigate.mock.calls[0]![0], "https://meltiply.local").searchParams;
    expect(query.get("metric")).toBe("likes");
    expect(query.get("range")).toBe("30d");
    expect(query.has("account")).toBe(false);
    expect(query.has("platform")).toBe(false);
    expect(query.has("format")).toBe(false);
  });

  it("renders the cohort KPIs, coverage, chart, and ranked Posts", () => {
    state.summary = {
      data: summary({
        by_platform: [
          platformRow(),
          platformRow({
            comments: 0,
            last_synced_at: "2026-10-30T12:00:00Z",
            likes: 1,
            platform: "threads",
            post_count: 1,
            shares: 0,
            views: 80,
          }),
        ],
      }),
      error: null,
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByLabelText("Views: 300")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Engagement by platform" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top posts" })).toBeInTheDocument();
    expect(screen.getByText(/Metrics are cumulative snapshots/)).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
  });

  it("omits the comparison card when the filter narrows to one platform", () => {
    state.searchParams = new URLSearchParams("metric=views&range=30d&platform=instagram");
    // Placeholder data can still carry the aggregate rows while the filtered
    // summary loads; the card must already be gone.
    state.summary = {
      data: summary({
        by_platform: [platformRow(), platformRow({ platform: "threads", views: 80 })],
      }),
      error: null,
      isFetching: true,
      isPending: false,
    };
    renderView();
    expect(
      screen.queryByRole("heading", { name: "Engagement by platform" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top posts" })).toBeInTheDocument();
  });

  it("re-ranks from a Post metric header", () => {
    renderView();
    expect(within(screen.getByRole("toolbar")).queryByRole("group", { name: "Metric" })).toBeNull();
    const topPosts = screen.getByRole("heading", { name: "Top posts" }).closest(".rounded-card");
    if (!topPosts) throw new Error("Top posts card missing");
    fireEvent.click(within(topPosts as HTMLElement).getByRole("button", { name: "Sort by Likes" }));
    expect(navigate).toHaveBeenCalledWith("/analytics?metric=likes&range=30d");
  });

  it("honors a shared range, metric, and platform from the URL", () => {
    state.searchParams = new URLSearchParams("range=7d&metric=comments&platform=threads");
    state.accounts = {
      data: [connectedAccount("instagram"), connectedAccount("threads")],
      error: null,
      isPending: false,
    };
    renderView();
    expect(screen.getByText(/Published Last 7 days/)).toBeInTheDocument();
    expect(screen.getByLabelText("Platform")).toHaveTextContent("Threads");
    const topPosts = screen.getByRole("heading", { name: "Top posts" }).closest(".rounded-card");
    if (!topPosts) throw new Error("Top posts card missing");
    expect(
      within(topPosts as HTMLElement)
        .getByRole("button", { name: "Sort by Comments" })
        .closest("th"),
    ).toHaveAttribute("aria-sort", "descending");
  });

  it("names unsupported platforms in a partial-data banner", () => {
    state.summary = {
      data: summary({ partial: true, unsupported_platforms: ["tiktok"] }),
      error: null,
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(
      screen.getByText("Partial data: no analytics are available for TikTok."),
    ).toBeInTheDocument();
  });

  it("links to Channels when no connected Channel reports analytics", () => {
    state.capabilities = {
      data: [capability("tiktok", false), capability("instagram", true)],
      error: null,
      isPending: false,
    };
    state.accounts = {
      data: [connectedAccount("tiktok")],
      error: null,
      isPending: false,
    };
    renderView();
    expect(
      screen.getByText("Analytics needs a connected channel that reports analytics."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Channels" })).toHaveAttribute(
      "href",
      "/channels",
    );
  });

  it("distinguishes no-posts, all-unsupported, and awaiting-first-sync cohorts", () => {
    state.summary = {
      data: summary({
        by_platform: [],
        last_synced_at: null,
        totals: { ...summary().totals, post_count: 0 },
      }),
      error: null,
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(screen.getByText("No published posts in this range.")).toBeInTheDocument();
    cleanup();

    state.summary = {
      data: summary({
        by_platform: [platformRow({ last_synced_at: null, platform: "youtube" })],
        partial: true,
        unsupported_platforms: ["youtube"],
      }),
      error: null,
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(
      screen.getByText("No analytics-capable published destinations in this range."),
    ).toBeInTheDocument();
    cleanup();

    state.summary = {
      data: summary({ by_platform: [platformRow({ last_synced_at: null })] }),
      error: null,
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(screen.getByText("Metrics appear after the first provider sync.")).toBeInTheDocument();
  });

  it("surfaces a retryable error without hiding the page header", () => {
    state.summary = { data: undefined, error: null, isFetching: false, isPending: false };
    state.dashboard = {
      data: undefined,
      error: new Error("Analytics are unavailable."),
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByText("Analytics could not be loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch.dashboard).toHaveBeenCalledOnce();
    expect(refetch.posts).toHaveBeenCalledOnce();
  });

  it("keeps a reference-query failure as an error, not missing-channel guidance", () => {
    state.capabilities = {
      data: [],
      error: new Error("Capabilities are unavailable."),
      isPending: false,
    };
    state.accounts = { data: [], error: null, isPending: false };
    state.summary = { data: undefined, error: null, isFetching: false, isPending: false };
    state.posts = { data: undefined, error: null, isFetching: false, isPending: false };
    renderView();
    expect(screen.getByText("Analytics could not be loaded")).toBeInTheDocument();
    expect(
      screen.queryByText("Analytics needs a connected channel that reports analytics."),
    ).not.toBeInTheDocument();
  });
});
