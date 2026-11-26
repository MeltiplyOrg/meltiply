import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "./api";
import { invalidateQueryKeys, mutationInvalidations, queryKeys, runBulkDelete } from "./queries";
import { WorkspaceService } from "./effect";

describe("React Query helpers", () => {
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

  it("refreshes the audit trail after every audited write", async () => {
    for (const keys of [
      mutationInvalidations.workspaceSettings(),
      mutationInvalidations.createBrandProfile(),
      mutationInvalidations.updateBrandProfile(),
      mutationInvalidations.deleteBrandProfile(),
      mutationInvalidations.disconnectPlatform("platform-1"),
      mutationInvalidations.confirmOAuthSelection(),
      mutationInvalidations.reportingPreferences(),
      mutationInvalidations.reportingFeedback(),
    ]) {
      const queryClient = new QueryClient();
      const auditKey = queryKeys.workspaceAudit({ limit: 25, offset: 0 });
      queryClient.setQueryData(auditKey, { entries: [] });

      await invalidateQueryKeys(queryClient, keys);

      expect(queryClient.getQueryState(auditKey)?.isInvalidated).toBe(true);
    }
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
          return yield* Effect.fail(
            new ApiError(new Response(null, { status: 400 }), {
              error: {
                code: "bad_request",
                details: [],
                message: "Post b was rejected",
                request_id: "req-test",
                retryable: false,
              },
            }),
          );
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
