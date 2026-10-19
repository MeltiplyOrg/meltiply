// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AnalyticsView } from "./analytics-view";
import type { AnalyticsSummary, PlatformMetrics } from "@/types";

const navigate = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => ({
  accounts: vi.fn(),
  capabilities: vi.fn(),
  posts: vi.fn(),
  summary: vi.fn(),
}));

const state = vi.hoisted(() => ({
  accounts: { data: [] as unknown[], error: null as Error | null, isPending: false },
  capabilities: { data: [] as unknown[], error: null as Error | null, isPending: false },
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
  useSessionScope: () => ({ brandProfileId: null, isSignedIn: true, workspaceId: "workspace-1" }),
}));
vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => ({ selectedBrandProfile: null }),
}));
vi.mock("@/lib/queries", () => ({
  usePlatformCapabilities: () => ({ ...state.capabilities, refetch: refetch.capabilities }),
  usePlatforms: () => ({ ...state.accounts, refetch: refetch.accounts }),
  useAnalyticsSummary: () => ({ ...state.summary, refetch: refetch.summary }),
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

function posts(overrides: Record<string, unknown> = {}) {
  return {
    has_more: false,
    limit: 10,
    offset: 0,
    posts: [
      {
        comments: 1,
        destination_count: 1,
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
    expect(screen.getByRole("heading", { name: "Platform comparison" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top posts" })).toBeInTheDocument();
    expect(screen.getByText(/Metrics are cumulative snapshots/)).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
  });

  it("omits the comparison card when only one platform has stored metrics", () => {
    state.searchParams = new URLSearchParams("metric=views&range=30d&platform=instagram");
    renderView();
    expect(screen.queryByRole("heading", { name: "Platform comparison" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top posts" })).toBeInTheDocument();
  });

  it("reloads stored metrics and updates shareable URL state", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Refresh analytics" }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["analytics"] });
    fireEvent.click(screen.getByRole("button", { name: "Likes" }));
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
    expect(screen.getByRole("button", { name: "Comments" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
    state.summary = {
      data: undefined,
      error: new Error("Analytics are unavailable."),
      isFetching: false,
      isPending: false,
    };
    renderView();
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByText("Analytics could not be loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch.summary).toHaveBeenCalledOnce();
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
