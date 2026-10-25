// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type {
  AnalyticsDashboard,
  AnalyticsPostsResponse,
  PlatformAccountsResponse,
  Post,
  CalendarEvent,
} from "@/types";
import {
  useAnalyticsDashboard,
  useAnalyticsPosts,
  useCalendar,
  useDeleteBrandProfile,
  usePlatforms,
  usePosts,
} from "./queries";

const scope = { isSignedIn: true, workspaceId: "workspace-a", brandProfileId: null };
let client: QueryClient;

/** Keeps the real query hooks, Effect services and HTTP client inside one browser scope. */
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("private browser read cache", () => {
  it("reuses Channel data for navigation, focus and reconnect within five minutes, then refreshes", async () => {
    const initial = contractSuccessBody<PlatformAccountsResponse>("listPlatformAccounts");
    const changed: PlatformAccountsResponse = { accounts: [] };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json(fetch.mock.calls.length === 1 ? initial : changed),
      );
    vi.stubGlobal("fetch", fetch);
    const first = renderHook(() => usePlatforms(scope), { wrapper: Wrapper });
    await waitFor(() => expect(first.result.current.data).toEqual(initial.accounts));
    first.unmount();

    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 4 * 60_000);
    const returned = renderHook(() => usePlatforms(scope), { wrapper: Wrapper });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(returned.result.current.data).toEqual(initial.accounts);
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(startedAt + 5 * 60_000 + 1);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(returned.result.current.data).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps dashboard and ranked Posts on one cached exact cohort through metric changes and refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    const requests: URL[] = [];
    const dashboard = contractSuccessBody<AnalyticsDashboard>("getAnalyticsDashboard");
    const posts = contractSuccessBody<AnalyticsPostsResponse>("getAnalyticsPosts");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push(url);
        return Response.json(url.pathname.endsWith("/dashboard") ? dashboard : posts);
      }),
    );
    const first = renderHook(
      ({ metric }: { metric: "views" | "likes" }) => ({
        dashboard: useAnalyticsDashboard(scope, { range: "30d" }),
        posts: useAnalyticsPosts(scope, { range: "30d", metric, limit: 10, offset: 0 }),
      }),
      { wrapper: Wrapper, initialProps: { metric: "views" } },
    );
    await waitFor(() => expect(first.result.current.posts.data).toEqual(posts));
    await waitFor(() => expect(first.result.current.dashboard.data).toEqual(dashboard));

    vi.setSystemTime(new Date("2026-10-25T12:00:30.000Z"));
    first.rerender({ metric: "likes" });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.map((url) => url.searchParams.get("end"))).toEqual([
      "2026-10-25T12:00:00.000Z",
      "2026-10-25T12:00:00.000Z",
      "2026-10-25T12:00:00.000Z",
    ]);
    first.unmount();

    vi.setSystemTime(new Date("2026-10-25T12:04:00.000Z"));
    const returned = renderHook(
      ({ metric }: { metric: "views" | "likes" }) => ({
        dashboard: useAnalyticsDashboard(scope, { range: "30d" }),
        posts: useAnalyticsPosts(scope, { range: "30d", metric, limit: 10, offset: 0 }),
      }),
      { wrapper: Wrapper, initialProps: { metric: "likes" } },
    );
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(returned.result.current.dashboard.data).toEqual(dashboard);
    expect(returned.result.current.posts.data).toEqual(posts);
    expect(requests).toHaveLength(3);

    vi.setSystemTime(new Date("2026-10-25T12:05:30.000Z"));
    returned.rerender({ metric: "views" });
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/dashboard"))
        .at(-1)
        ?.searchParams.get("end"),
    ).toBe(
      requests
        .filter((url) => url.pathname.endsWith("/posts"))
        .at(-1)
        ?.searchParams.get("end"),
    );

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["analytics"] });
    });
    await waitFor(() =>
      expect(requests.slice(-2).map((url) => url.searchParams.get("end"))).toEqual([
        "2026-10-25T12:05:30.000Z",
        "2026-10-25T12:05:30.000Z",
      ]),
    );
  });

  it("removes a deleted Brand Profile from warm Analytics without waiting for expiry", async () => {
    const dashboard = contractSuccessBody<AnalyticsDashboard>("getAnalyticsDashboard");
    const empty: AnalyticsDashboard = {
      ...dashboard,
      cohort: {
        ...dashboard.cohort,
        by_platform: [],
        last_synced_at: null,
        totals: { ...dashboard.cohort.totals, post_count: 0, views: 0 },
      },
    };
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const request = input instanceof Request ? input : new Request(String(input));
        if (request.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return Response.json(deleted ? empty : dashboard);
      }),
    );
    const view = renderHook(
      () => ({
        dashboard: useAnalyticsDashboard(scope, { range: "30d" }),
        remove: useDeleteBrandProfile(scope),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(view.result.current.dashboard.data).toEqual(dashboard));
    await act(async () => {
      await view.result.current.remove.mutateAsync("profile-a");
    });
    await waitFor(() =>
      expect(view.result.current.dashboard.data?.cohort.totals.post_count).toBe(0),
    );
  });

  it("updates in-flight Posts without refetching loaded pages or disturbing settled rows", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const pending: Post = {
      ...fixture,
      id: "pending-post",
      attachments: [],
      distributions: [{ ...distribution, post_id: "pending-post", status: "processing" }],
    };
    const settled: Post = { ...fixture, id: "settled-post", attachments: [], distributions: [] };
    const published: Post = {
      ...pending,
      distributions: [{ ...pending.distributions[0]!, status: "published" }],
    };
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith("/pending-post")) return Response.json(published);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return Response.json({
          posts: offset === 0 ? [pending] : [settled],
          has_more: offset === 0,
          limit: 60,
          offset,
        });
      }),
    );
    const view = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.data?.[0]?.id).toBe("pending-post"));
    await act(async () => {
      await view.result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(view.result.current.data?.map((post) => post.id)).toEqual([
        "pending-post",
        "settled-post",
      ]),
    );
    await waitFor(() =>
      expect(view.result.current.data?.[0]?.distributions[0]?.status).toBe("published"),
    );
    expect(view.result.current.data?.[1]).toEqual(settled);
    expect(paths.filter((path) => path.endsWith("/posts"))).toHaveLength(2);
    const completedReads = paths.length;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
    });
    expect(paths).toHaveLength(completedReads);
  }, 15_000);

  it("refreshes only active and newly due calendar outcomes, preserving settled events", async () => {
    const fixture = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const active: CalendarEvent = {
      id: "active-outcome",
      brand_profile_id: fixture.brand_profile_id,
      post_id: fixture.post_id,
      post_title: "Publishing",
      platform: fixture.platform,
      platform_account_id: fixture.platform_account_id,
      status: "processing",
      scheduled_at: null,
      published_at: null,
      updated_at: fixture.updated_at,
    };
    const scheduled: CalendarEvent = {
      ...active,
      id: "future-outcome",
      status: "scheduled",
      scheduled_at: new Date(startedAt + 60_000).toISOString(),
    };
    const settled: CalendarEvent = { ...active, id: "settled-outcome", status: "published" };
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith("/calendar"))
          return Response.json({ events: [active, scheduled, settled] });
        return Response.json({
          ...fixture,
          id: url.pathname.split("/").at(-1),
          status: "published",
        });
      }),
    );
    const view = renderHook(
      () =>
        useCalendar(scope, {
          start: new Date(startedAt - 60_000).toISOString(),
          end: new Date(startedAt + 120_000).toISOString(),
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(view.result.current.data?.[0]?.status).toBe("published"));
    expect(paths.some((path) => path.endsWith("/future-outcome"))).toBe(false);
    expect(view.result.current.data?.[2]).toEqual(settled);
    clock.mockReturnValue(startedAt + 61_000);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
    });
    await waitFor(() => expect(view.result.current.data?.[1]?.status).toBe("published"));
    expect(paths.filter((path) => path.endsWith("/calendar"))).toHaveLength(1);
    expect(paths.some((path) => path.endsWith("/settled-outcome"))).toBe(false);
  }, 15_000);
});
