import {
  createObjectStoreFromEnv,
  PROVIDER_MEDIA_ROUTE_PREFIX,
  validateProviderMediaKey,
  verifyProviderMediaSignature,
  type ConfiguredObjectStore,
} from "@meltiply/storage";
import { Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import type { AssetApiService } from "../asset-types";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnvironment } from "../env";
import { errorResponse, idempotencyHeaders, jsonResponse, noContentResponse } from "../responses";
import {
  completedPartsField,
  idempotencyKey,
  jsonBody,
  onlyKeys,
  partNumbersField,
  positiveIntegerField,
  stringField,
  uuidParam,
} from "../validation";
import { withStorageLayer, type CoreRouteServices } from "./shared";

const expiryPattern = /^\d{1,15}$/;

function providerMediaKey(pathname: string): string | undefined {
  const suffix = pathname.slice(PROVIDER_MEDIA_ROUTE_PREFIX.length);
  if (!suffix) return undefined;
  const segments: string[] = [];
  for (const encoded of suffix.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    if (!segment || segment.includes("/")) return undefined;
    segments.push(segment);
  }
  if (segments.length < 3) return undefined;
  try {
    return validateProviderMediaKey(segments.join("/"));
  } catch {
    return undefined;
  }
}

export function registerAssetRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get(`${PROVIDER_MEDIA_ROUTE_PREFIX}*`, async (c) => {
    const key = providerMediaKey(c.req.path);
    const expires = c.req.query("expires");
    const signature = c.req.query("signature");
    const expiresAt = expires && expiryPattern.test(expires) ? Number(expires) : NaN;
    if (
      !key ||
      !signature ||
      !Number.isSafeInteger(expiresAt) ||
      !(await verifyProviderMediaSignature(
        c.env.TOKEN_ENCRYPTION_KEY,
        expiresAt,
        key,
        signature,
      )) ||
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return errorResponse(
        c.get("requestId"),
        403,
        "media_url_invalid",
        "The media URL is invalid or has expired.",
      );
    }
    let store: ConfiguredObjectStore | undefined;
    try {
      store = createObjectStoreFromEnv(c.env);
    } catch {
      return errorResponse(
        c.get("requestId"),
        503,
        "service_unavailable",
        "Asset storage is unavailable.",
      );
    }
    const object = await store.read(key);
    if (!object) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The media object was not found.");
    }
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(object.size),
        "Content-Type": object.contentType ?? "application/octet-stream",
        "X-Request-ID": c.get("requestId"),
      },
      status: 200,
    });
  });

  app.post("/api/v1/asset-upload-sessions", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c));
          yield* fromPromise(() =>
            onlyKeys(body, [
              "asset_type",
              "brand_profile_id",
              "filename",
              "content_type",
              "file_size",
              "title",
            ]),
          );
          if (body.asset_type !== "image" && body.asset_type !== "video") {
            return yield* Effect.fail(
              new CoreApiError(400, "validation_error", "asset_type must be image or video."),
            );
          }
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(services.assets);
          const assetType = body.asset_type;
          const input = yield* fromPromise(
            () =>
              ({
                asset_type: assetType,
                brand_profile_id: uuidParam(
                  stringField(body, "brand_profile_id"),
                  "brand_profile_id",
                ),
                content_type: stringField(body, "content_type"),
                file_size: positiveIntegerField(body, "file_size"),
                filename: stringField(body, "filename"),
                title: stringField(body, "title"),
              }) satisfies Parameters<AssetApiService["createUploadSession"]>[2],
          );
          const result = yield* assetService.createUploadSession(
            c.env,
            c.get("actor").claims,
            input,
            key,
            c.get("requestId"),
          );
          return jsonResponse(result.value, 201, c.get("requestId"), {
            ...idempotencyHeaders(result.replayed),
          });
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/asset-upload-sessions/:sessionId", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const assetService = yield* fromPromise(services.assets);
          const sessionResult = yield* assetService.getUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
          );
          return jsonResponse(sessionResult, 200, c.get("requestId"));
        }),
        storageLayer,
      ),
    );
  });

  app.delete("/api/v1/asset-upload-sessions/:sessionId", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(services.assets);
          const result = yield* assetService.abortUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
            key,
          );
          return noContentResponse(c.get("requestId"), idempotencyHeaders(result.replayed));
        }),
        storageLayer,
      ),
    );
  });

  app.post("/api/v1/asset-upload-sessions/:sessionId/parts", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c));
          yield* fromPromise(() => onlyKeys(body, ["part_numbers"]));
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const partNumbers = yield* fromPromise(() => partNumbersField(body));
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(services.assets);
          const urls = yield* assetService.createUploadPartUrls(
            c.env,
            c.get("actor").claims,
            sessionId,
            { part_numbers: partNumbers },
            key,
          );
          return jsonResponse(urls, 200, c.get("requestId"));
        }),
        storageLayer,
      ),
    );
  });

  app.post("/api/v1/asset-upload-sessions/:sessionId/complete", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c, true));
          yield* fromPromise(() => onlyKeys(body, ["parts"]));
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const parts = yield* fromPromise(() => completedPartsField(body));
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(services.assets);
          const result = yield* assetService.completeUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
            { parts },
            key,
            c.get("requestId"),
          );
          return jsonResponse(result.value, 202, c.get("requestId"), {
            ...idempotencyHeaders(result.replayed),
          });
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId/download-url", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
          const assetService = yield* fromPromise(services.assets);
          const result = yield* assetService.getAssetDownloadUrl(
            c.env,
            c.get("actor").claims,
            assetId,
          );
          return jsonResponse(result, 200, c.get("requestId"));
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId/preview-url", (c) => {
    const storageLayer = services.resolveStorageLayer(c.env);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
          const assetService = yield* fromPromise(services.assets);
          const result = yield* assetService.getAssetPreviewUrl(
            c.env,
            c.get("actor").claims,
            assetId,
          );
          return jsonResponse(result, 200, c.get("requestId"));
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
        const assetService = yield* fromPromise(services.assets);
        const result = yield* assetService.getAsset(c.env, c.get("actor").claims, assetId);
        return jsonResponse(result, 200, c.get("requestId"));
      }),
    ),
  );
}
