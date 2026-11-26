import { Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import { auditActorFromResolved, recordWorkspaceAuditOnceBestEffort } from "../audit";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import { idempotencyHeaders, jsonResponse } from "../responses";
import {
  brandProfileColorField,
  brandProfileDescriptionField,
  brandProfileNameField,
  idempotencyKey,
  jsonBody,
  onlyKeys,
  uuidParam,
} from "../validation";
import type { CoreRouteServices } from "./shared";

export function registerBrandProfileRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/brand-profiles", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const profiles = yield* brandProfileService.listBrandProfiles(c.env, c.get("actor").claims);
        return jsonResponse({ profiles }, 200, c.get("requestId"));
      }),
    ),
  );

  app.post("/api/v1/brand-profiles", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "description", "color"]));
        const name = yield* fromPromise(() => brandProfileNameField(body, "name"));
        const description = yield* fromPromise(() =>
          brandProfileDescriptionField(body, "description"),
        );
        const color = yield* fromPromise(() => brandProfileColorField(body, "color"));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const result = yield* brandProfileService.createBrandProfile(
          c.env,
          c.get("actor").claims,
          { color, description, name },
          key,
        );
        const actor = c.get("actor");
        yield* recordWorkspaceAuditOnceBestEffort(
          c.env,
          {
            action: "brand_profile.created",
            actor: auditActorFromResolved(actor),
            after: result.value,
            orgId: actor.workspace.id,
            targetId: result.value.id,
            targetType: "brand_profile",
          },
          "brand-profile.create",
          key,
        );
        return jsonResponse(result.value, 201, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/brand-profiles/deleted", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const profiles = yield* brandProfileService.listDeletedBrandProfiles(
          c.env,
          c.get("actor").claims,
        );
        return jsonResponse({ profiles }, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const profile = yield* brandProfileService.getBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
        );
        return jsonResponse(profile, 200, c.get("requestId"));
      }),
    ),
  );

  app.patch("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "description", "color"]));
        const name =
          body.name !== undefined
            ? yield* fromPromise(() => brandProfileNameField(body, "name"))
            : undefined;
        const description =
          body.description !== undefined
            ? yield* fromPromise(() => brandProfileDescriptionField(body, "description"))
            : undefined;
        const color =
          body.color !== undefined
            ? yield* fromPromise(() => brandProfileColorField(body, "color"))
            : undefined;
        if (name === undefined && description === undefined && color === undefined) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "validation_error",
              "At least one of name, description, or color must be provided.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const result = yield* brandProfileService.updateBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          { color, description, name },
          key,
        );
        const actor = c.get("actor");
        yield* recordWorkspaceAuditOnceBestEffort(
          c.env,
          {
            action: "brand_profile.updated",
            actor: auditActorFromResolved(actor),
            after: result.value,
            orgId: actor.workspace.id,
            targetId: profileId,
            targetType: "brand_profile",
          },
          "brand-profile.update",
          key,
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const result = yield* brandProfileService.deleteBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          key,
        );
        const actor = c.get("actor");
        yield* recordWorkspaceAuditOnceBestEffort(
          c.env,
          {
            action: "brand_profile.deleted",
            actor: auditActorFromResolved(actor),
            after: result.value,
            orgId: actor.workspace.id,
            targetId: profileId,
            targetType: "brand_profile",
          },
          "brand-profile.delete",
          key,
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/brand-profiles/:profileId/restore", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const result = yield* brandProfileService.restoreBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          key,
        );
        const actor = c.get("actor");
        yield* recordWorkspaceAuditOnceBestEffort(
          c.env,
          {
            action: "brand_profile.restored",
            actor: auditActorFromResolved(actor),
            after: result.value,
            orgId: actor.workspace.id,
            targetId: profileId,
            targetType: "brand_profile",
          },
          "brand-profile.restore",
          key,
        );
        return jsonResponse(result.value, 200, c.get("requestId"), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
}
