// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AnalyticsToolbar } from "./analytics-toolbar";
import { MetricCards } from "./metric-cards";
import { PlatformEngagementChart } from "./platform-engagement-chart";
import { TopPostsTable } from "./top-posts-table";
import type { AnalyticsPostRow, AnalyticsSummary, PlatformMetrics } from "@/types";

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

afterEach(() => {
  cleanup();
});

function postRow(overrides: Partial<AnalyticsPostRow> = {}): AnalyticsPostRow {
  return {
    comments: 2,
    destination_count: 1,
    excerpt: "A short excerpt",
    last_synced_at: "2026-10-20T12:00:00Z",
    likes: 10,
    platforms: ["instagram"],
    post_id: "post-1",
    published_at: "2026-10-18T12:00:00Z",
    shares: 1,
    title: "Launch notes",
    unsupported_platforms: [],
    views: 1200,
    ...overrides,
  };
}

function platformRow(overrides: Partial<PlatformMetrics> = {}): PlatformMetrics {
  return {
    comments: 1,
    impressions: 0,
    last_synced_at: "2026-10-20T12:00:00Z",
    likes: 5,
    platform: "instagram",
    post_count: 2,
    reach: 0,
    shares: 1,
    views: 300,
    watch_time_sec: 0,
    ...overrides,
  };
}

const totals: AnalyticsSummary["totals"] = {
  comments: 3,
  impressions: 0,
  likes: 15,
  post_count: 3,
  reach: 0,
  shares: 2,
  views: 1500,
  watch_time_sec: 0,
};

const toolbarProps = {
  accounts: [],
  onAccountChange: vi.fn(),
  onFormatChange: vi.fn(),
  onPlatformChange: vi.fn(),
  onRangeChange: vi.fn(),
  onRefresh: vi.fn(),
  platforms: ["instagram", "threads"] as const,
  refreshing: false,
  selectedAccountId: undefined,
  selectedFormat: undefined,
  selectedPlatform: undefined,
  selectedRange: "30d" as const,
};

describe("analytics toolbar", () => {
  it("offers filters and a reload without a single-metric mode", () => {
    const onRefresh = vi.fn();
    render(<AnalyticsToolbar {...toolbarProps} onRefresh={onRefresh} />);
    expect(screen.queryByRole("group", { name: "Metric" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh analytics" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("marks the reload busy while stored metrics refetch", () => {
    render(<AnalyticsToolbar {...toolbarProps} refreshing />);
    expect(screen.getByRole("button", { name: "Refresh analytics" })).toBeDisabled();
  });
});

describe("analytics KPI cards", () => {
  it("shows exact grouped values and their definitions", () => {
    render(<MetricCards totals={totals} />);
    expect(screen.getByLabelText("Views: 1,500")).toBeInTheDocument();
    expect(screen.getByLabelText("Published destinations: 3")).toBeInTheDocument();
  });

  it("compacts only eight-digit totals on narrow screens while keeping the exact value", () => {
    render(<MetricCards totals={{ ...totals, views: 10_458_000 }} />);
    expect(screen.getByLabelText("Views: 10,458,000")).toBeInTheDocument();
    expect(screen.getByText("10.5M")).toBeInTheDocument();
    expect(screen.getByTitle("10,458,000")).toBeInTheDocument();
  });
});

describe("top Posts table", () => {
  it("renders measured values, Partial, Not supported, and Awaiting sync honestly", () => {
    render(
      <TopPostsTable
        posts={[
          postRow(),
          postRow({
            last_synced_at: "2026-10-20T12:00:00Z",
            platforms: ["instagram", "tiktok"],
            post_id: "post-2",
            title: "Mixed",
            unsupported_platforms: ["tiktok"],
            views: 900,
          }),
          postRow({
            last_synced_at: null,
            platforms: ["tiktok"],
            post_id: "post-3",
            title: "Unsupported",
            unsupported_platforms: ["tiktok"],
          }),
          postRow({
            last_synced_at: null,
            platforms: ["instagram"],
            post_id: "post-4",
            title: "Awaiting",
          }),
        ]}
        metric="views"
        limit={10}
        hasMore={false}
        loadingMore={false}
        onMetricChange={() => {}}
        onLoadMore={() => {}}
      />,
    );
    const table = within(screen.getByRole("table"));
    expect(table.getAllByText("1,200")).toHaveLength(1);
    expect(table.getAllByText("Partial")).toHaveLength(1);
    expect(table.getAllByText("Not supported")).toHaveLength(4);
    expect(table.getAllByText("Awaiting sync")).toHaveLength(4);
  });

  it("re-ranks from a metric header and loads more of the cohort", () => {
    const onMetricChange = vi.fn();
    const onLoadMore = vi.fn();
    render(
      <TopPostsTable
        posts={[postRow()]}
        metric="views"
        limit={10}
        hasMore
        loadingMore={false}
        onMetricChange={onMetricChange}
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by Comments" }));
    expect(onMetricChange).toHaveBeenCalledWith("comments");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});

describe("platform engagement chart", () => {
  it("stacks engagement in one chart and exposes the values as a table", () => {
    render(
      <PlatformEngagementChart
        rows={[
          platformRow(),
          platformRow({ last_synced_at: "2026-10-21T12:00:00Z", platform: "threads", views: 80 }),
          platformRow({ last_synced_at: null, platform: "facebook", post_count: 4, views: 0 }),
          platformRow({ platform: "tiktok", post_count: 2, views: 999 }),
        ]}
        rangeLabel="Last 30 days"
        unsupportedPlatforms={["tiktok"]}
      />,
    );
    const hiddenTable = screen.getByRole("table");
    // sr-only belongs on a block wrapper: table layout ignores its 1px sizing
    // and can leave the caption visibly floating.
    expect(hiddenTable.closest(".sr-only")).not.toBeNull();
    expect(hiddenTable).not.toHaveClass("sr-only");
    const table = within(hiddenTable);
    const instagram = table.getByRole("row", { name: /Instagram/ });
    expect(
      within(instagram)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["5", "1", "1", "7", "2", "300"]);
    expect(table.queryByText("TikTok")).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting first sync: Facebook")).toBeInTheDocument();
  });
});
