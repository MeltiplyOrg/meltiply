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
  invalidateQueryKeys,
  queryKeys,
  useAnalyticsPosts,
  useCalendar,
  useDeleteBrandProfile,
  usePlatforms,
  usePosts,
  useUpdatePost,
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
      ({ metric }: { metric: "views" | "likes" | "shares" }) => ({
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
    returned.rerender({ metric: "shares" });
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
      await invalidateQueryKeys(client, [queryKeys.analytics()]);
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
  it("refreshes a dense active Post page with a batched list read", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const pending = Array.from({ length: 60 }, (_, index): Post => {
      const id = `active-post-${index}`;
      return {
        ...fixture,
        id,
        attachments: [],
        distributions: [
          {
            ...distribution,
            id: `active-distribution-${index}`,
            post_id: id,
            status: "processing",
          },
        ],
      };
    });
    const published = pending.map((post) => ({
      ...post,
      distributions: post.distributions.map((item) => ({ ...item, status: "published" as const })),
    }));
    const analyticsKey = queryKeys.analyticsDashboard({ range: "30d" });
    client.setQueryData(
      analyticsKey,
      contractSuccessBody<AnalyticsDashboard>("getAnalyticsDashboard"),
    );
    let pageReads = 0;
    let detailReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/posts")) {
          pageReads += 1;
          return Response.json({
            posts: pageReads === 1 ? pending : published,
            has_more: false,
            limit: 60,
            offset: 0,
          });
        }
        detailReads += 1;
        return Response.json(published[0]);
      }),
    );

    const view = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => {
      expect(pageReads).toBe(2);
      expect(
        view.result.current.data?.every((post) =>
          post.distributions.every((item) => item.status === "published"),
        ),
      ).toBe(true);
    });

    expect(detailReads).toBe(0);
    expect(client.getQueryState(analyticsKey)?.isInvalidated).toBe(true);
  });

  it("does not cancel Load more when dense progress polls during pagination", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const active = ["first", "second"].map((id): Post => ({
      ...fixture,
      id,
      attachments: [],
      distributions: [
        { ...distribution, id: `${id}-distribution`, post_id: id, status: "processing" },
      ],
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nextStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const offset = Number(url.searchParams.get("offset"));
        if (offset > 0) {
          nextStarted = true;
          await gate;
        }
        return Response.json({
          posts:
            offset === 0
              ? active
              : [{ ...fixture, id: "next-page", distributions: [], attachments: [] }],
          has_more: offset === 0,
          offset,
          limit: 60,
        });
      }),
    );
    const view = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() =>
      expect(view.result.current.data?.map((post) => post.id)).toEqual(["first", "second"]),
    );
    await waitFor(() => expect(client.isFetching({ queryKey: ["post-progress"] })).toBe(0));
    let nextPage!: ReturnType<typeof view.result.current.fetchNextPage>;
    act(() => {
      nextPage = view.result.current.fetchNextPage();
    });
    await waitFor(() => expect(nextStarted).toBe(true));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["post-progress"] });
    });
    release();
    await act(async () => {
      await nextPage;
    });
    expect(view.result.current.data?.map((post) => post.id)).toEqual([
      "first",
      "second",
      "next-page",
    ]);
  });

  it("refreshes only active and newly due Calendar details, preserving settled events", async () => {
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
    let rangeReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith("/calendar")) {
          rangeReads += 1;
          return Response.json({
            events:
              rangeReads === 1
                ? [active, scheduled, settled]
                : [
                    { ...active, status: "published" },
                    { ...scheduled, status: "published" },
                    settled,
                  ],
          });
        }
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

  it("refreshes multiple active Calendar outcomes with one range read", async () => {
    const fixture = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const pending = ["active-first", "active-second"].map((id): CalendarEvent => ({
      ...fixture,
      id,
      status: "processing",
      post_title: "Publishing",
    }));
    const published = pending.map((event) => ({ ...event, status: "published" as const }));
    let rangeReads = 0;
    let detailReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/calendar")) {
          rangeReads += 1;
          return Response.json({ events: rangeReads === 1 ? pending : published });
        }
        detailReads += 1;
        return Response.json({ ...pending[0], status: "published" });
      }),
    );

    const view = renderHook(
      () =>
        useCalendar(scope, {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(rangeReads).toBe(2);
      expect(view.result.current.data?.every((event) => event.status === "published")).toBe(true);
    });

    expect(detailReads).toBe(0);
  });

  it("keeps unrelated Post and Calendar progress moving after an active resource disappears", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const posts = ["removed", "remaining"].map((id): Post => ({
      ...fixture,
      id,
      attachments: [],
      distributions: [
        { ...distribution, id: `${id}-distribution`, post_id: id, status: "processing" },
      ],
    }));
    const events = posts.map((post): CalendarEvent => ({
      ...post.distributions[0]!,
      post_title: post.title,
    }));
    client.setQueryData(queryKeys.post("removed"), posts[0]);
    let postReads = 0;
    let calendarReads = 0;
    let releaseMissing!: () => void;
    const missingGate = new Promise<void>((resolve) => {
      releaseMissing = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/posts")) {
          postReads += 1;
          return Response.json({
            posts:
              postReads === 1
                ? posts
                : [
                    {
                      ...posts[1],
                      distributions: [{ ...events[1], status: "published" }],
                    },
                  ],
            has_more: false,
            limit: 60,
            offset: 0,
          });
        }
        if (path.endsWith("/calendar")) {
          calendarReads += 1;
          return Response.json({
            events: calendarReads === 1 ? events : [{ ...events[1], status: "published" }],
          });
        }
        if (path.includes("/removed")) {
          await missingGate;
          return Response.json(
            { error: { code: "not_found", message: "Removed", retryable: false } },
            { status: 404 },
          );
        }
        if (path.includes("/distributions/"))
          return Response.json({ ...events[1], status: "published" });
        return Response.json({
          ...posts[1],
          distributions: [{ ...events[1], status: "published" }],
        });
      }),
    );
    const range = { start: "2026-01-01T00:00:00Z", end: "2026-12-31T00:00:00Z" };
    const view = renderHook(
      () => ({ posts: usePosts(scope), calendar: useCalendar(scope, range) }),
      { wrapper: Wrapper },
    );
    await waitFor(() =>
      expect(view.result.current.posts.data?.map((post) => post.id)).toEqual(["remaining"]),
    );
    expect(client.getQueryData(queryKeys.post("removed"))).toEqual(posts[0]);
    releaseMissing();
    await waitFor(() => {
      expect(view.result.current.posts.data?.map((post) => post.id)).toEqual(["remaining"]);
      expect(view.result.current.posts.data?.[0]?.distributions[0]?.status).toBe("published");
      expect(view.result.current.calendar.data?.map((event) => event.id)).toEqual([
        "remaining-distribution",
      ]);
      expect(view.result.current.calendar.data?.[0]?.status).toBe("published");
      expect(client.getQueryData(queryKeys.post("removed"))).toBeUndefined();
    });
  });

  it("expires collection membership from its last list fetch rather than a partial progress update", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const pending: Post = {
      ...fixture,
      attachments: [],
      distributions: [{ ...distribution, status: "processing" }],
    };
    const published: Post = {
      ...pending,
      distributions: [{ ...distribution, status: "published" }],
    };
    const changed: Post = {
      ...fixture,
      default_text: "Another member's change",
      attachments: [],
      distributions: [],
    };
    const initialTime = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detailStarted = false;
    let lists = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/posts")) {
          lists += 1;
          return Response.json({
            posts: [lists === 1 ? pending : changed],
            has_more: false,
            limit: 60,
            offset: 0,
          });
        }
        detailStarted = true;
        await gate;
        return Response.json(published);
      }),
    );
    const first = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => expect(detailStarted).toBe(true));
    clock.mockReturnValue(initialTime + 45_000);
    release();
    await waitFor(() =>
      expect(first.result.current.data?.[0]?.distributions[0]?.status).toBe("published"),
    );
    first.unmount();
    clock.mockReturnValue(initialTime + 61_000);
    const returned = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() =>
      expect(returned.result.current.data?.[0]?.default_text).toBe(changed.default_text),
    );
    expect(lists).toBe(2);
  });

  it("does not let a delayed progress response overwrite a later draft save", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const pending: Post = {
      ...fixture,
      distributions: [],
      attachments: fixture.attachments.map((attachment) => ({
        ...attachment,
        asset: { ...attachment.asset, status: "processing" },
      })),
    };
    const saved: Post = {
      ...pending,
      default_text: "Saved while processing",
      revision: pending.revision + 1,
    };
    let finishDetail: ((value: Post) => void) | undefined;
    const detail = new Promise<Post>((resolve) => {
      finishDetail = resolve;
    });
    let detailStarted = false;
    let didSave = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const request = input instanceof Request ? input : new Request(String(input));
        const url = new URL(request.url);
        if (request.method === "PATCH") {
          didSave = true;
          return Response.json(saved);
        }
        if (url.pathname.endsWith(`/${pending.id}`)) {
          detailStarted = true;
          return Response.json(await detail);
        }
        return Response.json({
          posts: [didSave ? saved : pending],
          has_more: false,
          limit: 60,
          offset: 0,
        });
      }),
    );
    const view = renderHook(() => ({ posts: usePosts(scope), save: useUpdatePost(scope) }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(detailStarted).toBe(true));
    await act(async () => {
      await view.result.current.save.mutateAsync({
        id: pending.id,
        input: { brand_profile_id: pending.brand_profile_id, default_text: saved.default_text },
      });
    });
    await waitFor(() =>
      expect(view.result.current.posts.data?.[0]?.default_text).toBe(saved.default_text),
    );
    await act(async () => {
      finishDetail?.(pending);
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(view.result.current.posts.data?.[0]?.default_text).toBe(saved.default_text);
    expect(client.getQueryData<Post>(queryKeys.post(pending.id))?.default_text).toBe(
      saved.default_text,
    );
  });
  it("clears a progress failure after an authoritative refresh settles all work", async () => {
    const fixture = contractSuccessBody<Post>("getPost");
    const distribution = contractSuccessBody<Post["distributions"][number]>("getDistribution");
    const pending: Post = {
      ...fixture,
      attachments: [],
      distributions: [{ ...distribution, status: "processing" }],
    };
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/posts")) {
          reads += 1;
          return Response.json({
            posts: [
              reads === 1
                ? pending
                : {
                    ...pending,
                    distributions: [{ ...distribution, status: "published" }],
                  },
            ],
            has_more: false,
            limit: 60,
            offset: 0,
          });
        }
        return Response.json(
          {
            error: {
              code: "internal_error",
              message: "Progress unavailable",
              retryable: false,
            },
          },
          { status: 500 },
        );
      }),
    );
    const view = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.error).not.toBeNull());
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() => {
      expect(view.result.current.data?.[0]?.distributions[0]?.status).toBe("published");
      expect(view.result.current.error).toBeNull();
    });
  });
});
