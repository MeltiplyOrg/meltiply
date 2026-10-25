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
import type { AnalyticsDashboard, AnalyticsPostsResponse, PlatformAccountsResponse } from "@/types";
import {
  useAnalyticsDashboard,
  useAnalyticsPosts,
  useDeleteBrandProfile,
  usePlatforms,
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
      () => ({
        dashboard: useAnalyticsDashboard(scope, { range: "30d" }),
        posts: useAnalyticsPosts(scope, { range: "30d", metric: "likes", limit: 10, offset: 0 }),
      }),
      { wrapper: Wrapper },
    );
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(returned.result.current.dashboard.data).toEqual(dashboard);
    expect(returned.result.current.posts.data).toEqual(posts);
    expect(requests).toHaveLength(3);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["analytics"] });
    });
    await waitFor(() =>
      expect(requests.slice(-2).map((url) => url.searchParams.get("end"))).toEqual([
        "2026-10-25T12:04:00.000Z",
        "2026-10-25T12:04:00.000Z",
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
});
