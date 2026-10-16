import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { invalidateQueryKeys, mutationInvalidations, queryKeys } from "./queries";

/**
 * Real QueryClient state must refresh affected Post/profile/detail resources
 * while leaving static platform capabilities cached. Load helpers through
 * Vitest's module graph before tests, rather than timing cold imports as queries.
 */
describe("React Query helpers", () => {
  /**
   * One Post mutation can change the Post itself, its attachment Asset rows,
   * the independent per-Channel outcomes, and their calendar projection, so
   * every Post write must refresh all four prefixes.
   */
  it("refreshes Post, outcome, calendar, and attachment caches on every Post write", async () => {
    const queryClient = new QueryClient();

    for (const mutation of [
      mutationInvalidations.createPost,
      mutationInvalidations.updatePost,
      mutationInvalidations.deletePost,
      mutationInvalidations.schedulePost,
    ]) {
      queryClient.setQueryData(queryKeys.posts(), []);
      queryClient.setQueryData(queryKeys.post("post-1"), { id: "post-1" });
      queryClient.setQueryData(queryKeys.distributions(), []);
      queryClient.setQueryData(queryKeys.calendar(), []);
      queryClient.setQueryData(queryKeys.asset("asset-1"), { id: "asset-1" });

      await invalidateQueryKeys(queryClient, mutation());

      expect(queryClient.getQueryState(queryKeys.posts())?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(queryKeys.post("post-1"))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(queryKeys.distributions())?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(queryKeys.calendar())?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(queryKeys.asset("asset-1"))?.isInvalidated).toBe(true);
    }
  });

  it("refreshes profile-scoped resource caches when a profile is restored", async () => {
    const queryClient = new QueryClient();
    const resourceKeys = [
      queryKeys.posts({ brand_profile_id: "profile-1" }),
      queryKeys.platforms({ brand_profile_id: "profile-1" }),
      queryKeys.distributions({ brand_profile_id: "profile-1" }),
      queryKeys.calendar({
        brand_profile_id: "profile-1",
        end: "2026-01-02",
        start: "2026-01-01",
      }),
    ];
    for (const queryKey of resourceKeys) {
      queryClient.setQueryData(queryKey, []);
    }

    await invalidateQueryKeys(queryClient, mutationInvalidations.restoreBrandProfile());

    for (const queryKey of resourceKeys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });

  it("invalidates detail queries through their list prefixes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.distribution("distribution-1"), { id: "distribution-1" });

    expect(queryClient.getQueryState(queryKeys.distribution("distribution-1"))?.isInvalidated).toBe(
      false,
    );

    await invalidateQueryKeys(queryClient, mutationInvalidations.updateDistribution());

    expect(queryClient.getQueryState(queryKeys.distribution("distribution-1"))?.isInvalidated).toBe(
      true,
    );
  });

  it("does not refetch static platform data after an account disconnect", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.platforms(), [{ id: "platform-1" }]);
    queryClient.setQueryData(queryKeys.platformCapabilities(), [{ platform: "youtube" }]);
    queryClient.setQueryData(queryKeys.platformPublishingRequirements("platform-1"), {
      requirements: [],
    });

    await invalidateQueryKeys(queryClient, mutationInvalidations.disconnectPlatform("platform-1"));

    expect(queryClient.getQueryState(queryKeys.platforms())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.platformCapabilities())?.isInvalidated).toBe(false);
    expect(
      queryClient.getQueryState(queryKeys.platformPublishingRequirements("platform-1"))
        ?.isInvalidated,
    ).toBe(true);
  });
});
