// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Post, PostListResponse } from "@/types";
import { listPosts } from "./api";
import { usePosts } from "./queries";

// Keep the real frontend Effect service Layer and query cache; only the HTTP
// adapter is replaced so the tests can control page boundaries and transport failure.
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  listPosts: vi.fn(),
}));

const scope = { isSignedIn: true, workspaceId: "workspace-a", brandProfileId: null };
const fixture = contractSuccessBody<Post>("getPost");
let client: QueryClient;

/** Creates settled Posts so the test observes explicit pagination, not lifecycle polling. */
function posts(start: number, count: number): Post[] {
  return Array.from({ length: count }, (_, index) => ({
    ...fixture,
    id: `post-${start + index}`,
    status: "draft",
    attachments: [],
    distributions: [],
  }));
}

/** Supplies the same browser cache across hook mounts, as route/view navigation does. */
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(listPosts).mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Post pagination and browser cache", () => {
  it("fetches 60 at a time only on demand, stops at the final page, and reuses cached pages", async () => {
    const all = posts(0, 121);
    vi.mocked(listPosts).mockImplementation((_workspace, params) => {
      const offset = params?.offset ?? 0;
      const page: PostListResponse = {
        posts: all.slice(offset, offset + 60),
        offset,
        limit: 60,
        has_more: offset + 60 < all.length,
      };
      return Effect.succeed(page);
    });
    const first = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() =>
      expect(first.result.current.data?.map((post) => post.id)).toEqual(
        all.slice(0, 60).map((post) => post.id),
      ),
    );
    expect(vi.mocked(listPosts).mock.calls.map(([, params]) => params)).toEqual([
      { limit: 60, offset: 0 },
    ]);

    await act(async () => {
      await first.result.current.fetchNextPage();
    });
    await act(async () => {
      await first.result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(first.result.current.data?.map((post) => post.id)).toEqual(all.map((post) => post.id)),
    );
    expect(first.result.current.hasNextPage).toBe(false);
    await act(async () => {
      await first.result.current.fetchNextPage();
    });
    expect(vi.mocked(listPosts).mock.calls.map(([, params]) => params)).toEqual([
      { limit: 60, offset: 0 },
      { limit: 60, offset: 60 },
      { limit: 60, offset: 120 },
    ]);

    first.unmount();
    const returned = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    expect(returned.result.current.data?.map((post) => post.id)).toEqual(
      all.map((post) => post.id),
    );
    expect(listPosts).toHaveBeenCalledTimes(3);
  });

  it("keeps the current page on a failed next read and retries that same offset", async () => {
    let failNext = true;
    vi.mocked(listPosts).mockImplementation((_workspace, params) => {
      const offset = params?.offset ?? 0;
      if (offset === 60 && failNext) return Effect.die(new Error("Offline"));
      return Effect.succeed({
        posts: posts(offset, 60),
        offset,
        limit: 60,
        has_more: offset === 0,
      });
    });
    const { result } = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    // fetchNextPage settles before TanStack's scheduled observer notification.
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data?.map((post) => post.id)).toEqual(
      posts(0, 60).map((post) => post.id),
    );
    failNext = false;
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(result.current.data?.map((post) => post.id)).toEqual(
        posts(0, 120).map((post) => post.id),
      ),
    );
    expect(vi.mocked(listPosts).mock.calls.map(([, params]) => params?.offset)).toEqual([
      0, 60, 60,
    ]);
  });

  it("does not duplicate a Post when an offset boundary shifts between reads", async () => {
    vi.mocked(listPosts).mockImplementation((_workspace, params) => {
      const offset = params?.offset ?? 0;
      return Effect.succeed({
        posts: offset === 0 ? posts(0, 60) : posts(59, 2),
        offset,
        limit: 60,
        has_more: offset === 0,
      });
    });
    const { result } = renderHook(() => usePosts(scope), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() =>
      expect(result.current.data?.map((post) => post.id)).toEqual(
        posts(0, 61).map((post) => post.id),
      ),
    );
  });
});
