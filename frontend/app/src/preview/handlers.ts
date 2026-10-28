import { Schema } from "effect";
import { http, HttpResponse } from "msw";
import contract from "virtual:preview-contract";
import {
  previewObjectSchema,
  type PreviewObject,
  type PreviewOperation,
  type PreviewResponse,
} from "./contract-types";
import type { PreviewOptions } from "./scenarios";
import { emptyValue, scenarioValue } from "./values";
import { createPreviewUploads } from "./uploads";
import { createPreviewState } from "./state";

const bootstrapOperations: Record<string, true> = {
  getAuthSession: true,
  getSetupStatus: true,
  getCurrentUser: true,
  listBrandProfiles: true,
  listPlatformCapabilities: true,
};

/** Converts a scenario result into an HTTP response without forwarding credentials, redirects, or requests to an upstream service. */
function responseFor(result: PreviewResponse, operationId: string): Response {
  const headers = { "Content-Type": "application/json", "X-Preview-Operation": operationId };
  return new HttpResponse(
    result.body === undefined || [204, 205, 304].includes(result.status)
      ? null
      : JSON.stringify(result.body),
    { status: result.status, headers },
  );
}

/** Registers every contract operation automatically. Build-time seed projections supply public workspace data; browser scenarios, local CRUD, and Blobs never access Postgres, credentials, or external effects. Each factory call resets the scenario. */
export function createPreviewHandlers(options: PreviewOptions = {}) {
  const now = Date.now();
  const fixtures = Object.assign(
    Schema.decodeUnknownSync(previewObjectSchema)(scenarioValue(contract.fixtures, options, now)),
    Schema.decodeUnknownSync(previewObjectSchema)(
      scenarioValue(contract.seedFixtures, options, now, "", 0),
    ),
  );
  const operations = contract.operations.map((operation): PreviewOperation => ({
    ...operation,
    success: {
      status: operation.success.status,
      ...(operation.success.body === undefined
        ? {}
        : {
            body: scenarioValue(
              operation.success.body,
              options,
              now,
              "",
              operation.seeded ? 0 : undefined,
            ),
          }),
    },
    errors: operation.errors.map((response) => ({
      status: response.status,
      ...(response.body === undefined ? {} : { body: scenarioValue(response.body, options, now) }),
    })),
    responses: operation.responses.map((response) => ({
      status: response.status,
      ...(response.body === undefined
        ? {}
        : {
            body: scenarioValue(
              response.body,
              options,
              now,
              "",
              operation.seeded && response.status === operation.success.status ? 0 : undefined,
            ),
          }),
    })),
  }));
  const uploads = createPreviewUploads(
    Schema.decodeUnknownSync(previewObjectSchema)(fixtures.asset),
    Schema.decodeUnknownSync(previewObjectSchema)(fixtures.upload_session),
  );
  for (const asset of Schema.decodeUnknownSync(Schema.Array(previewObjectSchema))(fixtures.assets))
    if (typeof asset.id === "string") uploads.assets.set(asset.id, asset);
  const storedResponse = createPreviewState(operations, uploads.assets);
  let signedIn = !["signed-out", "first-run", "two-factor"].includes(
    options.scenario ?? "populated",
  );
  let initialized = options.scenario !== "first-run";

  /** Chooses existing error examples where available; common synthetic transport failures reuse canonical error envelopes. */
  function failure(operation: PreviewOperation, status: number, fixture: string): PreviewResponse {
    return (
      operation.errors.find((response) => response.status === status) ?? {
        status,
        body: fixtures[fixture] ?? fixtures.invalid_request_error ?? null,
      }
    );
  }

  const generated = [...operations]
    .sort(
      (left, right) =>
        (left.path.match(/\{/g)?.length ?? 0) - (right.path.match(/\{/g)?.length ?? 0),
    )
    .map((operation) =>
      http[operation.method](
        operation.path.replace(/\{([^}]+)\}/g, ":$1"),
        async ({ request, params }) => {
          const scoped = options.operationId
            ? options.operationId === operation.operationId
            : !bootstrapOperations[operation.operationId];
          if (scoped && options.responseStatus !== undefined) {
            const selected = operation.responses.find(
              (response) => response.status === options.responseStatus,
            );
            return responseFor(
              selected ?? failure(operation, 400, "invalid_request_error"),
              operation.operationId,
            );
          }
          if (scoped && options.scenario === "loading") {
            const { promise, resolve } = Promise.withResolvers<void>();
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener("abort", () => resolve(), { once: true });
            await promise;
            return HttpResponse.error();
          }
          if (scoped && options.scenario === "server-error")
            return responseFor(failure(operation, 503, "dependency_error"), operation.operationId);
          if (scoped && options.scenario === "permission-denied")
            return responseFor(failure(operation, 403, "forbidden_error"), operation.operationId);
          if (
            scoped &&
            options.scenario === "validation-error" &&
            (operation.method !== "get" || options.operationId)
          )
            return responseFor(failure(operation, 422, "validation_error"), operation.operationId);

          if (operation.operationId === "getAuthSession")
            return responseFor(
              signedIn ? operation.success : { status: 200, body: null },
              operation.operationId,
            );
          if (operation.operationId === "getSetupStatus")
            return responseFor({ status: 200, body: { initialized } }, operation.operationId);
          if (operation.operationId === "signOut") signedIn = false;
          if (operation.operationId === "signInWithEmail" && options.scenario === "two-factor")
            return responseFor(
              { status: 200, body: { twoFactorRedirect: true } },
              operation.operationId,
            );
          if (
            ["signInWithEmail", "signUpWithEmail", "verifyTotp", "verifyBackupCode"].includes(
              operation.operationId,
            )
          ) {
            signedIn = true;
            initialized = true;
          }
          if (
            !signedIn &&
            !operation.path.startsWith("/api/auth/") &&
            !["getWorkspaceInvitation", "getHealth", "getReadiness"].includes(operation.operationId)
          )
            return responseFor(
              failure(operation, 401, "authentication_error"),
              operation.operationId,
            );

          let input: PreviewObject = {};
          if (
            !["get", "head"].includes(operation.method) &&
            request.headers.get("Content-Type")?.includes("application/json")
          ) {
            try {
              input = Schema.decodeUnknownSync(previewObjectSchema)(await request.json());
            } catch {
              return responseFor(
                failure(operation, 400, "invalid_request_error"),
                operation.operationId,
              );
            }
          }
          if (operation.operationId === "startPlatformOAuth") {
            const selection = Schema.decodeUnknownSync(previewObjectSchema)(
              fixtures.oauth_selection,
            );
            const url = new URL("/channels/connect", request.url);
            url.searchParams.set("selection_id", String(selection.id));
            url.searchParams.set("provider", String(selection.platform));
            return responseFor(
              { status: 200, body: { authorization_url: url.href } },
              operation.operationId,
            );
          }
          const result =
            uploads.handle(operation, request, params, input) ??
            storedResponse(operation, request, params, input) ??
            operation.success;
          if (
            scoped &&
            options.scenario === "empty" &&
            operation.method === "get" &&
            result.body !== undefined
          )
            return responseFor(
              { status: result.status, body: emptyValue(result.body) },
              operation.operationId,
            );
          if (result.status >= 400 && result.body === undefined)
            return responseFor(
              failure(operation, result.status, "not_found_error"),
              operation.operationId,
            );
          return responseFor(result, operation.operationId);
        },
      ),
    );
  // The device-authorization endpoints are plugin-owned rather than OpenAPI
  // operations. These synthetic handlers let the Routes tab open the real
  // consent page in the isolated preview without a backend.
  const previewDeviceHandlers = [
    http.post("/api/auth/device/code", ({ request }) => {
      const origin = new URL(request.url).origin;
      const userCode = "PREVIEW1";
      return HttpResponse.json({
        device_code: "preview-device-code",
        expires_in: 600,
        interval: 5,
        user_code: userCode,
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=${userCode}`,
      });
    }),
    http.get("/api/auth/device", ({ request }) => {
      const userCode = new URL(request.url).searchParams.get("user_code") ?? "PREVIEW1";
      return HttpResponse.json({
        client_id: "melti-cli",
        scope: "",
        status: "pending",
        user_code: userCode,
      });
    }),
    http.post("/api/auth/device/approve", () => HttpResponse.json({ success: true })),
    http.post("/api/auth/device/deny", () => HttpResponse.json({ success: true })),
  ];
  return [
    ...previewDeviceHandlers,
    ...generated,
    uploads.blobHandler,
    http.post("/__frontend-telemetry", () => new HttpResponse(null, { status: 204 })),
    http.all(/\/api(?:\/|$)/, () =>
      HttpResponse.json(
        {
          error: {
            code: "preview_unhandled",
            message: "No operation in the current OpenAPI contract matches this preview request.",
            request_id: "ui-preview",
            retryable: false,
            details: [],
          },
        },
        { status: 501 },
      ),
    ),
  ];
}
