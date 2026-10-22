// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  AccumulationChart,
  BestTimeHeatmap,
  ContentFormatBreakdown,
  EngagementOverTimeChart,
  FollowerEvolutionChart,
  FrequencyScatterChart,
  MetricOverTimeChart,
  PlatformBreakdownTable,
  PostsOverTimeChart,
  PostsPerPlatformChart,
} from "./analytics-insights";
import type { AnalyticsDashboard } from "@/types";

beforeAll(() => {
  class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

const fixture: AnalyticsDashboard = {
  accumulation: [
    { avg_engagement: 12, elapsed_hours: 1, observations: 3 },
    { avg_engagement: 45, elapsed_hours: 24, observations: 3 },
  ],
  best_times: [
    {
      avg_comments: 2,
      avg_engagement: 25,
      avg_likes: 20,
      avg_shares: 3,
      avg_views: 200,
      day_of_week: 1,
      hour: 14,
      posts: 3,
    },
    {
      avg_comments: 0,
      avg_engagement: 5,
      avg_likes: 5,
      avg_shares: 0,
      avg_views: 40,
      day_of_week: 2,
      hour: 9,
      posts: 1,
    },
  ],
  followers: [
    {
      account_id: "e3000000-0000-4000-8000-000000000001",
      account_name: "Alpha Page",
      platform: "facebook",
      points: [
        { captured_at: "2026-10-01T12:00:00Z", followers: 5000 },
        { captured_at: "2026-10-22T12:00:00Z", followers: 5200 },
      ],
    },
  ],
  formats: [
    {
      avg_engagement: 25,
      avg_views: 200,
      comments: 6,
      engagement: 75,
      format: "video",
      last_synced_at: "2026-10-22T12:00:00Z",
      likes: 60,
      posts: 3,
      shares: 9,
      views: 600,
    },
    {
      avg_engagement: 10,
      avg_views: 80,
      comments: 1,
      engagement: 10,
      format: "text",
      last_synced_at: "2026-10-20T12:00:00Z",
      likes: 8,
      posts: 1,
      shares: 1,
      views: 80,
    },
  ],
  platforms: [
    {
      clicks: null,
      comments: 6,
      engagement_rate: 0.125,
      follower_gain: 200,
      followers: 5200,
      impressions: 800,
      last_synced_at: "2026-10-22T12:00:00Z",
      likes: 60,
      platform: "facebook",
      posts: 3,
      reach: 500,
      saves: null,
      shares: 9,
      views: 600,
    },
  ],
  range: { end: "2026-10-22T23:59:59Z", start: "2026-10-01T00:00:00Z" },
  series: [
    {
      comments: 2,
      date: "2026-10-05",
      impressions: 200,
      last_synced_at: "2026-10-05T12:00:00Z",
      likes: 20,
      platform: "facebook",
      posts: 1,
      reach: 150,
      shares: 3,
      views: 200,
    },
    {
      comments: 4,
      date: "2026-10-12",
      impressions: 600,
      last_synced_at: "2026-10-12T12:00:00Z",
      likes: 40,
      platform: "facebook",
      posts: 2,
      reach: 350,
      shares: 6,
      views: 400,
    },
  ],
  unavailable_metrics: ["saves", "clicks"],
};

describe("analytics insights dashboard components", () => {
  it("renders posts per platform with total header", () => {
    render(<PostsPerPlatformChart dashboard={fixture} />);
    expect(screen.getByRole("heading", { name: "Posts per platform" })).toBeInTheDocument();
    expect(screen.getByText("3 published destinations")).toBeInTheDocument();
  });

  it("renders metric over time with grouping toggles", () => {
    render(<MetricOverTimeChart dashboard={fixture} metric="views" />);
    expect(screen.getByRole("heading", { name: "Views over time" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders multi-series engagement over time with metric filters", () => {
    render(<EngagementOverTimeChart dashboard={fixture} />);
    expect(screen.getByRole("heading", { name: "Engagement over time" })).toBeInTheDocument();
    const likesToggle = screen.getByRole("button", { name: "Likes" });
    expect(likesToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(likesToggle);
    expect(likesToggle).toHaveAttribute("aria-pressed", "false");
  });

  it("renders the 7x24 best time heatmap and identifies the best slot", () => {
    render(<BestTimeHeatmap dashboard={fixture} />);
    expect(screen.getByRole("heading", { name: "Best time to post" })).toBeInTheDocument();
    expect(screen.getByText(/Best slot: Mon 14:00 · 25 average · 3 posts/)).toBeInTheDocument();
  });

  it("renders follower evolution and current/gain totals", () => {
    render(<FollowerEvolutionChart dashboard={fixture} />);
    expect(screen.getByRole("heading", { name: "Follower evolution" })).toBeInTheDocument();
    expect(screen.getByText(/Current 5,200 · net \+200/)).toBeInTheDocument();
  });

  it("renders content format breakdown with relative bars and best badge", () => {
    render(<ContentFormatBreakdown dashboard={fixture} />);
    expect(screen.getByRole("heading", { name: "Content format breakdown" })).toBeInTheDocument();
    expect(screen.getByText("Video")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Best")).toBeInTheDocument();
  });

  it("renders platform breakdown table with honest null indicators", () => {
    render(<PlatformBreakdownTable dashboard={fixture} />);
    expect(screen.getByText("12.5%")).toBeInTheDocument();
    expect(screen.getAllByText("Not tracked")).toHaveLength(2);
  });

  it("renders scatter chart and accumulation", () => {
    render(
      <>
        <PostsOverTimeChart dashboard={fixture} />
        <FrequencyScatterChart dashboard={fixture} />
        <AccumulationChart dashboard={fixture} />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Posts over time" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Posting frequency vs engagement" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Engagement accumulation" })).toBeInTheDocument();
  });
});
