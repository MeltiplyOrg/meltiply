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
import type { PlatformAccountsResponse } from "@/types";
import { usePlatforms } from "./queries";

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
});
