import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ApiClientService, createApiClientServiceTest } from "./api-client";
import { runQueryEffect } from "./runtime";
import { WorkspaceService } from "./session-scope";

type UserProfile = components["schemas"]["UserProfile"];

const mockProfile: UserProfile = {
  active_organization: {
    id: "org_alpha",
    name: "Alpha Corp",
    role: "admin",
    slug: "alpha-corp",
  },
  avatar_url: null,
  created_at: "2026-09-12T12:00:00.000Z",
  display_name: "Ada Lovelace",
  email: "ada@example.com",
  id: "user_ada",
  updated_at: "2026-09-12T12:00:00.000Z",
};

describe("runQueryEffect (React Query Effect adapter)", () => {
  it("resolves the effect outcome on success", async () => {
    const program = Effect.succeed({ test: "value" });
    const result = await runQueryEffect(program);
    expect(result).toEqual({ test: "value" });
  });

  it("propagates typed failures as rejected promises", async () => {
    const customError = new Error("Expected failure");
    const program = Effect.fail(customError);

    await expect(runQueryEffect(program)).rejects.toThrow("Expected failure");
  });

  it("interrupts fiber when AbortSignal triggers cancellation", async () => {
    const controller = new AbortController();
    let cleanedUp = false;

    const program = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          cleanedUp = true;
        }),
      );
      yield* Effect.sleep("500 millis");
      return "done";
    });

    const promise = runQueryEffect(program, { signal: controller.signal });
    // Abort after a small tick
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow();
    // Verify interruption triggered finalizer
    expect(cleanedUp).toBe(true);
  });

  it("does not execute effect body when signal is already aborted", async () => {
    let executed = false;
    const controller = new AbortController();
    controller.abort();

    const program = Effect.sync(() => {
      executed = true;
      return "executed";
    });

    await expect(runQueryEffect(program, { signal: controller.signal })).rejects.toThrow();

    expect(executed).toBe(false);
  });

  it("surfaces defects when cause contains both a typed failure and a defect", async () => {
    const defectError = new Error("Catastrophic finalizer crash");
    const typedError = new Error("Normal domain error");

    const program = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.die(defectError));
      return yield* Effect.fail(typedError);
    });

    await expect(runQueryEffect(program)).rejects.toThrow(defectError);
  });
});

describe("ApiClientService", () => {
  it("allows test layer substitution without ad-hoc global mocking", async () => {
    const program = Effect.gen(function* () {
      const client = yield* ApiClientService;
      return yield* client.getCurrentUser();
    }).pipe(
      Effect.provide(
        createApiClientServiceTest({
          getCurrentUser: () =>
            Effect.flatMap(WorkspaceService, (workspace) =>
              workspace.workspaceId === "workspace-1"
                ? Effect.succeed(mockProfile)
                : Effect.die(new Error("Workspace selection was not provided to the service")),
            ),
        }),
      ),
      Effect.provideService(WorkspaceService, { workspaceId: "workspace-1" }),
    );

    const result = await runQueryEffect(program);
    expect(result).toEqual(mockProfile);
  });
});
