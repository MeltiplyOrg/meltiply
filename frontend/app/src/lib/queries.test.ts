import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { invalidateQueryKeys, mutationInvalidations, queryKeys, runBulkDelete } from "./queries";
import { WorkspaceService, type ApiClientError } from "./effect";

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

describe("bulk Post deletion", () => {
  /**
   * Six targets prove the bound rather than a coincidental two; the fake
   * operation fails one typed request and dies on another so transport defects
   * cannot abort the batch or hide committed successes.
   */
  it("bounds concurrency, isolates failures, and keys each request by position", async () => {
    const targets = ["a", "b", "c", "d", "e", "f"].map((id) => ({
      brandProfileId: `profile-${id}`,
      id,
    }));
    const keys: string[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;

    const deleteOne = (target: (typeof targets)[number], idempotencyKey: string) =>
      Effect.gen(function* () {
        keys.push(idempotencyKey);
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
        inFlight -= 1;
        if (target.id === "b") {
          return yield* Effect.fail({
            message: "Post b was rejected",
          } as unknown as ApiClientError);
        }
        if (target.id === "c") {
          return yield* Effect.die(new Error("network down"));
        }
        return target.id;
      });

    const outcome = await Effect.runPromise(
      Effect.provideService(runBulkDelete(deleteOne, targets, "batch-key"), WorkspaceService, {
        workspaceId: null,
      }),
    );

    expect(maximumInFlight).toBeLessThanOrEqual(4);
    expect(keys).toEqual(targets.map((_, index) => `batch-key:${index}`));
    expect(outcome.deletedIds).toEqual(["a", "d", "e", "f"]);
    expect(outcome.failed).toEqual([
      { id: "b", message: "Post b was rejected" },
      { id: "c", message: "network down" },
    ]);
  });
});
