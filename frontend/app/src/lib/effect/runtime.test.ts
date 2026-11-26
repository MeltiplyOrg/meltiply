import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ApiClientService, createApiClientServiceTest } from "./api-client";
import { runQueryEffect } from "./runtime";
import { WorkspaceService } from "./session-scope";

const profile: components["schemas"]["UserProfile"] = {
  active_organization: { id: "org_alpha", name: "Alpha Corp", role: "admin", slug: "alpha-corp" },
  avatar_url: null,
  created_at: "2026-09-12T12:00:00.000Z",
  display_name: "Ada Lovelace",
  is_installation_owner: false,
  email: "ada@example.com",
  id: "user_ada",
  updated_at: "2026-09-12T12:00:00.000Z",
};

function pendingUntilAborted(finalized: string[]) {
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => finalized.push("finalized")));
    return yield* Effect.never;
  });
}

describe("runQueryEffect", () => {
  it("a success", async () => {
    expect(await runQueryEffect(Effect.succeed({ test: "value" }))).toEqual({ test: "value" });
  });

  it("a typed failure", async () => {
    const failure = new Error("Expected failure");

    await expect(runQueryEffect(Effect.fail(failure))).rejects.toBe(failure);
  });

  it("a defect", async () => {
    const defect = new Error("bug");

    await expect(runQueryEffect(Effect.die(defect))).rejects.toBe(defect);
  });

  it("a finalizer defect beside a typed failure", async () => {
    const defect = new Error("Catastrophic finalizer crash");
    const program = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.die(defect));
      return yield* Effect.fail(new Error("Normal domain error"));
    });

    await expect(runQueryEffect(program)).rejects.toBe(defect);
  });

  it("an abort while running", async () => {
    const controller = new AbortController();
    const finalized: string[] = [];
    const reason = new Error("left the page");

    const running = runQueryEffect(pendingUntilAborted(finalized), { signal: controller.signal });
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(finalized).toEqual(["finalized"]);
  });

  it("a signal aborted before the start", async () => {
    const ran: string[] = [];
    const reason = new Error("already gone");

    const running = runQueryEffect(
      Effect.sync(() => ran.push("ran")),
      { signal: AbortSignal.abort(reason) },
    );

    await expect(running).rejects.toBe(reason);
    expect(ran).toEqual([]);
  });
});

describe("ApiClientService", () => {
  it("a substituted client reading the selected workspace", async () => {
    const program = Effect.gen(function* () {
      const client = yield* ApiClientService;
      return yield* client.getCurrentUser();
    }).pipe(
      Effect.provide(
        createApiClientServiceTest({
          getCurrentUser: () =>
            Effect.flatMap(WorkspaceService, (workspace) =>
              workspace.workspaceId === "workspace-1"
                ? Effect.succeed(profile)
                : Effect.die(new Error("Workspace selection was not provided to the service")),
            ),
        }),
      ),
      Effect.provideService(WorkspaceService, { workspaceId: "workspace-1" }),
    );

    expect(await runQueryEffect(program)).toEqual(profile);
  });
});
