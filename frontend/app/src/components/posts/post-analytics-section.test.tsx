// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PostAnalyticsSection } from "./post-analytics-section";
import type { PostAnalyticsSummary } from "./posts-helpers";

const state = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  data: [
    {
      snapshots: [
        {
          id: "s1",
          distribution_id: "d1",
          post_id: "p1",
          likes: 12,
          comments: 2,
          shares: 3,
          views: 250,
          reach: 100,
          impressions: 300,
          watch_time_sec: 0,
          snapshot_at: "2026-07-01T10:00:00Z",
        },
      ],
    },
  ],
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: true, workspaceId: "w1" }),
}));
vi.mock("@/lib/queries", () => ({ usePostAnalyticsHistory: () => state }));

const summary: PostAnalyticsSummary = {
  awaiting: false,
  channels: [
    {
      id: "d1",
      label: "YouTube",
      platform: "youtube",
      analytics: {
        likes: 12,
        comments: 2,
        shares: 3,
        views: 250,
        reach: 100,
        impressions: 300,
        saves: null,
        clicks: null,
      },
    },
  ],
  metrics: [{ id: "views", value: 250 }],
  untracked: ["saves", "clicks"],
  visible: true,
};
afterEach(() => {
  cleanup();
  state.isError = false;
  state.isPending = false;
});

describe("Post analytics timelines", () => {
  it("exposes engagement and exposure measurements separately, including a single snapshot", () => {
    render(<PostAnalyticsSection analytics={summary} />);
    const engagement = screen.getByRole("table", { name: "Engagement over time" });
    expect(within(engagement).getByRole("cell", { name: "12" })).toBeInTheDocument();
    expect(within(engagement).getByRole("cell", { name: "2" })).toBeInTheDocument();
    expect(within(engagement).getByRole("cell", { name: "3" })).toBeInTheDocument();
    const exposure = screen.getByRole("table", { name: "Reach & impressions over time" });
    expect(within(exposure).getByRole("cell", { name: "100" })).toBeInTheDocument();
    expect(within(exposure).getByRole("cell", { name: "300" })).toBeInTheDocument();
  });
  it("keeps failed history distinct from a measured zero and offers retry", () => {
    state.isError = true;
    render(<PostAnalyticsSection analytics={summary} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Analytics could not be loaded");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledOnce();
  });
  it("does not draw untracked reach as measured zero", () => {
    render(
      <PostAnalyticsSection analytics={{ ...summary, untracked: ["reach", "impressions"] }} />,
    );
    expect(
      screen.queryByRole("table", { name: "Reach & impressions over time" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Not measured")).toBeInTheDocument();
  });
});
