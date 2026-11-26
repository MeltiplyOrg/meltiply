import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ApiError } from "./api";
import { WorkspaceService } from "./effect";
import { invalidateQueryKeys, mutationInvalidations, queryKeys, runBulkDelete } from "./queries";

describe("invalidateQueryKeys", () => {
  it.each([
    ["createPost", mutationInvalidations.createPost],
    ["updatePost", mutationInvalidations.updatePost],
    ["deletePost", mutationInvalidations.deletePost],
    ["schedulePost", mutationInvalidations.schedulePost],
  ])("%s invalidates Post, distribution, calendar, and asset caches", async (_name, keys) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.posts(), []);
    queryClient.setQueryData(queryKeys.post("post-1"), { id: "post-1" });
    queryClient.setQueryData(queryKeys.distributions(), []);
    queryClient.setQueryData(queryKeys.calendar(), []);
    queryClient.setQueryData(queryKeys.asset("asset-1"), { id: "asset-1" });

    await invalidateQueryKeys(queryClient, keys());

    expect({
      asset: queryClient.getQueryState(queryKeys.asset("asset-1"))?.isInvalidated,
      calendar: queryClient.getQueryState(queryKeys.calendar())?.isInvalidated,
      distributions: queryClient.getQueryState(queryKeys.distributions())?.isInvalidated,
      post: queryClient.getQueryState(queryKeys.post("post-1"))?.isInvalidated,
      posts: queryClient.getQueryState(queryKeys.posts())?.isInvalidated,
    }).toEqual({
      asset: true,
      calendar: true,
      distributions: true,
      post: true,
      posts: true,
    });
  });

  it("updateDistribution invalidates detail queries through their list prefix", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.distribution("distribution-1"), { id: "distribution-1" });

    await invalidateQueryKeys(queryClient, mutationInvalidations.updateDistribution());

    expect(
      queryClient.getQueryState(queryKeys.distribution("distribution-1"))?.isInvalidated,
    ).toEqual(true);
  });

  it.each([
    ["workspaceSettings", mutationInvalidations.workspaceSettings()],
    ["createBrandProfile", mutationInvalidations.createBrandProfile()],
    ["updateBrandProfile", mutationInvalidations.updateBrandProfile()],
    ["deleteBrandProfile", mutationInvalidations.deleteBrandProfile()],
    ["disconnectPlatform", mutationInvalidations.disconnectPlatform("platform-1")],
    ["confirmOAuthSelection", mutationInvalidations.confirmOAuthSelection()],
    ["reportingPreferences", mutationInvalidations.reportingPreferences()],
    ["reportingFeedback", mutationInvalidations.reportingFeedback()],
  ])("%s invalidates workspace audit queries", async (_name, keys) => {
    const queryClient = new QueryClient();
    const auditKey = queryKeys.workspaceAudit({ limit: 25, offset: 0 });
    queryClient.setQueryData(auditKey, { entries: [] });

    await invalidateQueryKeys(queryClient, keys);

    expect(queryClient.getQueryState(auditKey)?.isInvalidated).toEqual(true);
  });

  it("disconnectPlatform leaves static platform capabilities intact", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.platforms(), [{ id: "platform-1" }]);
    queryClient.setQueryData(queryKeys.platformCapabilities(), [{ platform: "youtube" }]);
    queryClient.setQueryData(queryKeys.platformPublishingRequirements("platform-1"), {
      requirements: [],
    });

    await invalidateQueryKeys(queryClient, mutationInvalidations.disconnectPlatform("platform-1"));

    expect({
      capabilities: queryClient.getQueryState(queryKeys.platformCapabilities())?.isInvalidated,
      platforms: queryClient.getQueryState(queryKeys.platforms())?.isInvalidated,
      requirements: queryClient.getQueryState(
        queryKeys.platformPublishingRequirements("platform-1"),
      )?.isInvalidated,
    }).toEqual({
      capabilities: false,
      platforms: true,
      requirements: true,
    });
  });
});

describe("runBulkDelete", () => {
  it("bounds concurrency at four, isolates failures, and keys each request by position", async () => {
    const targets = ["a", "b", "c", "d", "e", "f"].map((id) => ({
      brandProfileId: `profile-${id}`,
      id,
    }));
    const keys: string[] = [];
    const waiters: (() => void)[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;

    const deleteOne = (target: (typeof targets)[number], idempotencyKey: string) =>
      Effect.gen(function* () {
        keys.push(idempotencyKey);
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              waiters.push(resolve);
              if (waiters.length === 4 || keys.length === targets.length) {
                for (const wake of waiters.splice(0)) wake();
              }
            }),
        );
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

    expect(maximumInFlight).toEqual(4);
    expect(keys).toEqual(targets.map((_, index) => `batch-key:${index}`));
    expect(outcome).toEqual({
      deletedIds: ["a", "d", "e", "f"],
      failed: [
        { id: "b", message: "Post b was rejected" },
        { id: "c", message: "network down" },
      ],
    });
  });
});
