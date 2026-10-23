// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PostAnalyticsSection } from "./post-analytics-section";
import type { PostAnalyticsSummary } from "./posts-helpers";
import type { Post } from "@/types";

const counters = {
  likes: 12,
  comments: 2,
  shares: 3,
  saves: null,
  clicks: null,
  views: 250,
  impressions: 300,
  reach: 100,
} satisfies NonNullable<Post["analytics"]>;

const summary: PostAnalyticsSummary = {
  awaiting: false,
  channels: [
    {
      analytics: { ...counters, likes: 10, views: 200 },
      id: "dist-youtube",
      label: "YouTube",
      platform: "youtube",
    },
    {
      analytics: { ...counters, likes: 2, views: 50 },
      id: "dist-tiktok",
      label: "TikTok",
      platform: "tiktok",
    },
  ],
  metrics: [
    { id: "likes", value: 12 },
    { id: "comments", value: 2 },
    { id: "shares", value: 3 },
    { id: "views", value: 250 },
  ],
  untracked: ["saves", "clicks", "impressions", "reach"],
  visible: true,
};

afterEach(() => {
  cleanup();
});

describe("post analytics section", () => {
  it("shows totals and a per-Channel bar comparison for the selected metric", () => {
    render(<PostAnalyticsSection analytics={summary} />);

    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    const channels = screen.getByRole("list", { name: "Channels" });
    expect(within(channels).getByText("YouTube")).toBeInTheDocument();
    expect(within(channels).getByText("TikTok")).toBeInTheDocument();
    expect(within(channels).getByText("200")).toBeInTheDocument();
    expect(within(channels).getByText("50")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Likes" }));
    expect(within(channels).getByText("10")).toBeInTheDocument();
    expect(within(channels).getByText("2")).toBeInTheDocument();
  });

  it("renders the awaiting state without inventing a chart", () => {
    render(
      <PostAnalyticsSection
        analytics={{ ...summary, awaiting: true, channels: [], metrics: [] }}
      />,
    );

    expect(screen.getByText("Metrics appear after the first provider sync.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Channels" })).not.toBeInTheDocument();
  });
});
