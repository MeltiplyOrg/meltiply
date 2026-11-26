import type { OAuthSelectionCandidate } from "@meltiply/contracts";
import type { components } from "@meltiply/contracts/schema";
import {
  DatabaseError,
  isDevelopmentEnvironment,
  oauthCallbackPath,
  type Platform,
} from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";
import {
  createProviderServiceLive,
  failureDiagnostic,
  ProviderAdapterError,
  ProviderService,
  type OAuthConnection,
  type OAuthExchangeResult,
  type ProviderPublicationRequirements,
} from "@meltiply/providers";
import { Cause, Effect } from "effect";
import type { Hono } from "hono";

import { CoreApiError } from "../api-errors";
import {
  auditActorFromResolved,
  recordWorkspaceAuditBestEffort,
  recordWorkspaceAuditOnceBestEffort,
} from "../audit";
import { scheduleBackgroundWork } from "../background-continuation";
import { fromPromise } from "../effect/route";
import { runRouteEffect } from "../effect/runtime";
import type { ApiWorkerEnv, ApiWorkerEnvironment, OAuthStateStub } from "../env";
import { idempotencyHeaders, jsonResponse, noContentResponse } from "../responses";
import { tokenCipherFor } from "../token-credentials";
import {
  idempotencyKey,
  jsonBody,
  OAUTH_ROUTING_KEY_PATTERN,
  onlyKeys,
  platformParam,
  stringField,
  uuidParam,
} from "../validation";
import { optionalBrandProfileParam, type CoreRouteServices } from "./shared";

type Schemas = components["schemas"];

const base64PaddingPattern = /=+$/;
const deterministicDatabaseErrorPattern = /^(22|23)[0-9A-Z]{3}$/;
const selectionNotFoundMessage = "The OAuth account selection does not exist or has expired.";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(base64PaddingPattern, "");
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

export async function oauthStateRoutingKey(organizationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId));
  return base64Url(new Uint8Array(digest).slice(0, 16));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function oauthStateStub(env: ApiWorkerEnv, routingKey: string): OAuthStateStub {
  if (!env.OAUTH_STATE) {
    throw new CoreApiError(503, "service_unavailable", "OAuth state storage is unavailable.");
  }
  return env.OAUTH_STATE.getByName(routingKey);
}

function oauthCallbackUrl(env: ApiWorkerEnv, provider: Platform): string {
  if (!env.APP_URL) {
    throw new CoreApiError(503, "service_unavailable", "The public API URL is unavailable.");
  }
  const target = new URL(oauthCallbackPath(provider), env.APP_URL);
  if (
    target.protocol !== "https:" &&
    !(isDevelopmentEnvironment(env.ENVIRONMENT) && target.hostname === "localhost")
  ) {
    throw new CoreApiError(503, "service_unavailable", "The public API URL is not secure.");
  }
  return target.toString();
}

function frontendRedirect(
  env: ApiWorkerEnv,
  provider: Platform,
  outcome: string,
  extraParams?: Record<string, string>,
  pathname = "/channels",
): string {
  if (!env.APP_URL) {
    throw new CoreApiError(
      503,
      "service_unavailable",
      "The frontend redirect target is unavailable.",
    );
  }
  const target = new URL(pathname, env.APP_URL);
  target.searchParams.set("oauth", outcome);
  target.searchParams.set("provider", provider);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      target.searchParams.set(key, value);
    }
  }
  return target.toString();
}

function oauthExchangeDiagnostic(failure: unknown) {
  return {
    ...errorDiagnostic(failure),
    ...(failure instanceof ProviderAdapterError ? failureDiagnostic(failure) : {}),
  };
}

function oauthExchangeOutcome(failure: unknown): string {
  return failure instanceof ProviderAdapterError &&
    failure.failure.code.endsWith("_selection_required")
    ? "selection_required"
    : "provider_error";
}

function publishingRequirementsBody(
  value: ProviderPublicationRequirements,
): Schemas["PublishingRequirements"] {
  return {
    comment_allowed: value.commentAllowed,
    creator: {
      avatar_url: value.creatorAvatarUrl ?? null,
      display_name: value.creatorDisplayName,
      username: value.creatorUsername,
    },
    duet_allowed: value.duetAllowed,
    max_video_duration_sec: value.maxVideoDurationSeconds,
    platform: value.platform,
    privacy_levels: [...value.privacyLevels],
    stitch_allowed: value.stitchAllowed,
  };
}

function resolveSelectionRoutingKey(
  rawSelectionId: string | undefined,
  organizationId: string,
): Effect.Effect<{ routingKey: string; selectionId: string }, CoreApiError> {
  return Effect.gen(function* () {
    const selectionId = rawSelectionId?.trim() ?? "";
    if (selectionId.length < 16 || selectionId.length > 256) {
      return yield* Effect.fail(new CoreApiError(404, "not_found", selectionNotFoundMessage));
    }
    const routingKey = yield* Effect.promise(() => oauthStateRoutingKey(organizationId));
    if (selectionId.includes(".")) {
      const keyPart = selectionId.split(".", 1)[0] ?? "";
      if (OAUTH_ROUTING_KEY_PATTERN.test(keyPart) && keyPart !== routingKey) {
        return yield* Effect.fail(new CoreApiError(404, "not_found", selectionNotFoundMessage));
      }
    }
    return { routingKey, selectionId };
  });
}

export function registerPlatformRoutes(
  app: Hono<ApiWorkerEnvironment>,
  services: CoreRouteServices,
): void {
  app.get("/api/v1/platforms/capabilities", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const core = yield* fromPromise(services.service);
        const capabilities = yield* fromPromise(() => core.platformCapabilities());
        return jsonResponse({ capabilities }, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/platforms", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const core = yield* fromPromise(services.service);
        const accounts = yield* core.listPlatformAccounts(
          c.env,
          c.get("actor").claims,
          brandProfileId,
        );
        return jsonResponse({ accounts }, 200, c.get("requestId"));
      }),
    ),
  );

  app.get("/api/v1/platforms/:accountId/publishing-requirements", (c) => {
    const response = runRouteEffect(
      c,
      Effect.gen(function* () {
        const accountId = yield* fromPromise(() =>
          uuidParam(c.req.param("accountId"), "account_id"),
        );
        const requirements = yield* services.readPublicationRequirements(
          c.env,
          c.get("actor").claims,
          accountId,
          c.get("requestId"),
          services.registry(),
        );
        return jsonResponse(publishingRequirementsBody(requirements), 200, c.get("requestId"));
      }).pipe(Effect.provide(createProviderServiceLive(services.registry()))),
    );
    scheduleBackgroundWork(
      c,
      response.then(
        () => undefined,
        () => undefined,
      ),
    );
    return response;
  });

  app.get("/api/v1/platforms/:platform/connect", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selected = yield* fromPromise(() => platformParam(c.req.param("platform")));
        const core = yield* fromPromise(services.service);
        const capability = core
          .platformCapabilities()
          .find((candidate) => candidate.platform === selected);
        if (!capability?.connect_available) {
          return yield* Effect.fail(
            new CoreApiError(
              422,
              "unsupported_capability",
              `${selected} connection is not available.`,
            ),
          );
        }
        const adapter = services.registry().get(selected);
        if (!adapter?.authorizationUrl || !adapter.exchangeAuthorizationCode) {
          return yield* Effect.fail(
            new CoreApiError(503, "provider_unavailable", `${selected} OAuth is not configured.`),
          );
        }
        const actor = c.get("actor");
        const organizationId = actor.workspace.id;
        const routingKey = yield* fromPromise(() => oauthStateRoutingKey(organizationId));
        const state = `${routingKey}.${randomBase64Url(32)}`;
        const verifier = randomBase64Url(32);
        const redirectUri = yield* fromPromise(() => oauthCallbackUrl(c.env, selected));
        yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).create(state, {
            expires_at: Date.now() + 10 * 60 * 1_000,
            organization_id: organizationId,
            pkce_verifier: verifier,
            provider: selected,
            redirect_path: "/channels",
            user_id: actor.userId,
          }),
        );
        const challenge = yield* fromPromise(() => pkceChallenge(verifier));
        const authorizationUrl = new URL(
          adapter.authorizationUrl({
            codeChallenge: challenge,
            redirectUri,
            state,
          }),
        );
        if (authorizationUrl.protocol !== "https:") {
          return yield* Effect.fail(
            new CoreApiError(
              503,
              "provider_unavailable",
              `${selected} OAuth returned an insecure authorization URL.`,
            ),
          );
        }
        if (c.req.header("Accept")?.includes("application/json")) {
          return jsonResponse(
            { authorization_url: authorizationUrl.toString() },
            200,
            c.get("requestId"),
          );
        }
        return Response.redirect(authorizationUrl.toString(), 307);
      }),
    ),
  );

  app.get("/api/v1/platforms/:platform/callback", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selected = yield* fromPromise(() => platformParam(c.req.param("platform")));
        const redirectTo = (outcome: string) =>
          fromPromise(() => Response.redirect(frontendRedirect(c.env, selected, outcome), 302));
        const state = c.req.query("state")?.trim() ?? "";
        if (state.length < 16) {
          return yield* redirectTo("state_invalid");
        }
        const routingKey = state.split(".", 1)[0] ?? "";
        if (!OAUTH_ROUTING_KEY_PATTERN.test(routingKey)) {
          return yield* redirectTo("state_invalid");
        }
        const record = yield* fromPromise(() => oauthStateStub(c.env, routingKey).consume(state));
        if (
          !record ||
          record.provider !== selected ||
          record.expires_at <= Date.now() ||
          record.redirect_path !== "/channels"
        ) {
          return yield* redirectTo("state_invalid");
        }
        const providerError = c.req.query("error");
        if (providerError) {
          return yield* redirectTo(
            providerError === "access_denied" ? "consent_denied" : "provider_error",
          );
        }
        const authorizationCode = c.req.query("code");
        if (!authorizationCode) {
          return yield* redirectTo("missing_code");
        }
        const adapter = services.registry().get(selected);
        if (!adapter?.exchangeAuthorizationCode || !record.pkce_verifier) {
          return yield* redirectTo("provider_unavailable");
        }
        const codeVerifier = record.pkce_verifier;
        const exchanged: OAuthExchangeResult | Response = yield* Effect.gen(function* () {
          const redirectUri = yield* fromPromise(() => oauthCallbackUrl(c.env, selected));
          const providerService = yield* ProviderService;
          return yield* providerService.exchangeAuthorizationCode(
            selected,
            {
              operationId: "completePlatformOAuth",
              requestId: c.get("requestId"),
            },
            {
              code: authorizationCode,
              codeVerifier,
              redirectUri,
            },
          );
        }).pipe(
          Effect.catchCause((cause) => {
            const failure = Cause.squash(cause);
            const outcome = oauthExchangeOutcome(failure);
            return fromPromise(() => {
              log(
                "warn",
                {
                  environment: c.env.ENVIRONMENT,
                  request_id: c.get("requestId"),
                  service: "api",
                  trace_id: c.get("traceId"),
                  user_id: record.user_id,
                  version: c.env.VERSION,
                },
                {
                  error_code: "provider_exchange_failed",
                  event: "oauth_exchange_failed",
                  message: `${selected} OAuth exchange failed`,
                  outcome,
                  provider: selected,
                  retry_class: "none",
                  ...oauthExchangeDiagnostic(failure),
                },
              );
              return Response.redirect(frontendRedirect(c.env, selected, outcome), 302);
            });
          }),
        );
        if (exchanged instanceof Response) return exchanged;
        const discovered = "accounts" in exchanged ? exchanged.accounts : [exchanged];
        const selectionId = `${routingKey}.${randomBase64Url(32)}`;
        const staged: Response | undefined = yield* Effect.gen(function* () {
          const cipher = tokenCipherFor(c.env);
          yield* fromPromise(() =>
            oauthStateStub(c.env, routingKey).createSelection(selectionId, {
              expires_at: Date.now() + 10 * 60 * 1_000,
              id: selectionId,
              organization_id: record.organization_id,
              platform: selected,
              user_id: record.user_id,
            }),
          );
          const BATCH_SIZE = 50;
          for (let i = 0; i < discovered.length; i += BATCH_SIZE) {
            const chunk = discovered.slice(i, i + BATCH_SIZE);
            const candidates: OAuthSelectionCandidate[] = [];
            for (const account of chunk) {
              const sealed = yield* Effect.tryPromise({
                catch: (cause) =>
                  new DatabaseError({
                    cause,
                    message: "Failed to encrypt candidate OAuth connection.",
                  }),
                try: () => cipher.encrypt(JSON.stringify(account)),
              });
              candidates.push({
                account: {
                  avatar_url: account.account.avatarUrl ?? null,
                  display_name: account.account.displayName ?? null,
                  id: account.account.id,
                  username: account.account.username ?? null,
                },
                encryptedConnection: sealed,
              });
            }
            yield* fromPromise(() =>
              oauthStateStub(c.env, routingKey).appendSelectionCandidates(selectionId, candidates),
            );
          }
          yield* fromPromise(() =>
            oauthStateStub(c.env, routingKey).finalizeSelection(selectionId),
          );
        }).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) =>
            fromPromise(() => {
              log(
                "error",
                {
                  environment: c.env.ENVIRONMENT,
                  request_id: c.get("requestId"),
                  service: "api",
                  trace_id: c.get("traceId"),
                  user_id: record.user_id,
                  version: c.env.VERSION,
                },
                {
                  error_code: "oauth_staging_failed",
                  event: "oauth_staging_failed",
                  outcome: "connection_failed",
                  provider: selected,
                  retry_class: "client_retry",
                  ...errorDiagnostic(Cause.squash(cause)),
                },
              );
              return Response.redirect(frontendRedirect(c.env, selected, "connection_failed"), 302);
            }),
          ),
        );
        if (staged instanceof Response) return staged;
        return yield* fromPromise(() =>
          Response.redirect(
            frontendRedirect(
              c.env,
              selected,
              "select_account",
              { selection_id: selectionId },
              "/channels/connect",
            ),
            302,
          ),
        );
      }).pipe(Effect.provide(createProviderServiceLive(services.registry()))),
    ),
  );

  app.delete("/api/v1/platforms/:accountId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const accountId = yield* fromPromise(() =>
          uuidParam(c.req.param("accountId"), "account_id"),
        );
        const disconnectKey = yield* fromPromise(() => idempotencyKey(c));
        yield* services
          .revokeConnection(c.env, c.get("actor").claims, accountId, services.registry())
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                log(
                  "warn",
                  {
                    environment: c.env.ENVIRONMENT,
                    request_id: c.get("requestId"),
                    service: "api",
                    trace_id: c.get("traceId"),
                    version: c.env.VERSION,
                  },
                  {
                    error_code: "provider_revoke_failed",
                    event: "oauth_remote_revoke_failed",
                    outcome: "ignored",
                    retry_class: "none",
                    ...errorDiagnostic(Cause.squash(cause)),
                  },
                ),
              ),
            ),
          );
        const core = yield* fromPromise(services.service);
        const result = yield* core.disconnectPlatform(
          c.env,
          c.get("actor").claims,
          accountId,
          disconnectKey,
        );
        const actor = c.get("actor");
        yield* recordWorkspaceAuditOnceBestEffort(
          c.env,
          {
            action: "channel.disconnected",
            actor: auditActorFromResolved(actor),
            before: { account_id: accountId },
            orgId: actor.workspace.id,
            targetId: accountId,
            targetType: "channel",
          },
          "channel.disconnect",
          disconnectKey,
        );
        return noContentResponse(c.get("requestId"), idempotencyHeaders(result.replayed));
      }).pipe(Effect.provide(createProviderServiceLive(services.registry()))),
    ),
  );

  app.get("/api/v1/oauth-selections/:selectionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const { routingKey, selectionId } = yield* resolveSelectionRoutingKey(
          c.req.param("selectionId"),
          actor.workspace.id,
        );
        const selection = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).getSelection(selectionId, {
            organizationId: actor.workspace.id,
            userId: actor.userId,
          }),
        );
        if (!selection) {
          return yield* Effect.fail(new CoreApiError(404, "not_found", selectionNotFoundMessage));
        }
        return jsonResponse(selection, 200, c.get("requestId"));
      }),
    ),
  );

  app.post("/api/v1/oauth-selections/:selectionId/confirm", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const { routingKey, selectionId } = yield* resolveSelectionRoutingKey(
          c.req.param("selectionId"),
          actor.workspace.id,
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["account_id", "brand_profile_id"]));
        const rawAccountId = yield* fromPromise(() => stringField(body, "account_id"));
        const accountId = rawAccountId.trim();
        if (!accountId || accountId.length > 255) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "invalid_request",
              "account_id must be a non-empty string under 255 characters.",
            ),
          );
        }
        const brandProfileId = yield* fromPromise(() =>
          uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
        );
        const brandProfileService = yield* fromPromise(services.brandProfiles);
        const profile = yield* brandProfileService.getBrandProfile(
          c.env,
          actor.claims,
          brandProfileId,
        );
        if (profile.deleted_at !== null) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "brand_profile_deleted",
              "The brand profile is deleted and cannot accept new data.",
            ),
          );
        }
        const claim = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).claimSelection(
            selectionId,
            accountId,
            {
              brandProfileId,
              organizationId: actor.workspace.id,
              userId: actor.userId,
            },
            key,
          ),
        );
        if (claim.status === "not_found") {
          return yield* Effect.fail(new CoreApiError(404, "not_found", selectionNotFoundMessage));
        }
        if (claim.status === "replayed") {
          return noContentResponse(c.get("requestId"), idempotencyHeaders(true));
        }
        if (claim.status === "invalid_account") {
          return yield* Effect.fail(new CoreApiError(400, "invalid_request", claim.message));
        }
        if (claim.status === "conflict") {
          return yield* Effect.fail(new CoreApiError(409, "invalid_state", claim.message));
        }
        const cipher = tokenCipherFor(c.env);
        const plaintext = yield* Effect.tryPromise({
          catch: () =>
            new CoreApiError(
              500,
              "internal_error",
              "Failed to decrypt OAuth connection credentials.",
            ),
          try: () => cipher.decrypt(claim.encryptedConnection),
        });
        const connection: OAuthConnection = yield* Effect.try({
          catch: () =>
            new CoreApiError(500, "internal_error", "Invalid connection credentials payload."),
          try: () => {
            const parsed: unknown = JSON.parse(plaintext);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("accessToken" in parsed) ||
              typeof parsed.accessToken !== "string" ||
              !parsed.accessToken ||
              !("account" in parsed) ||
              typeof parsed.account !== "object" ||
              parsed.account === null ||
              !("id" in parsed.account) ||
              parsed.account.id !== accountId
            ) {
              throw new TypeError("Invalid connection credentials payload.");
            }
            return parsed as OAuthConnection;
          },
        });
        yield* services
          .saveConnection(
            c.env,
            claim.platform as Platform,
            {
              brandProfileId,
              organizationId: claim.organizationId,
              userId: claim.userId,
            },
            connection,
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const failure = Cause.squash(cause);
                const databaseCause = failure instanceof DatabaseError ? failure.cause : undefined;
                const deterministicDatabaseFailure =
                  databaseCause !== null &&
                  typeof databaseCause === "object" &&
                  "code" in databaseCause &&
                  typeof databaseCause.code === "string" &&
                  deterministicDatabaseErrorPattern.test(databaseCause.code);
                if (failure instanceof CoreApiError || deterministicDatabaseFailure) {
                  yield* fromPromise(() =>
                    oauthStateStub(c.env, routingKey).releaseSelectionClaim(
                      selectionId,
                      claim.claimToken,
                    ),
                  );
                }
                return yield* Effect.failCause(cause);
              }),
            ),
          );
        const completed = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).completeSelection(
            selectionId,
            accountId,
            claim.claimToken,
            key,
          ),
        );
        if (!completed) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The selection confirmation could not be finalized. Please restart authorization.",
            ),
          );
        }
        yield* recordWorkspaceAuditBestEffort(c.env, {
          action: "channel.connected",
          actor: auditActorFromResolved(actor),
          after: {
            account_id: accountId,
            brand_profile_id: brandProfileId,
            platform: claim.platform,
          },
          orgId: actor.workspace.id,
          requestId: c.get("requestId"),
          targetId: accountId,
          targetType: "channel",
        });
        return noContentResponse(c.get("requestId"), idempotencyHeaders(false));
      }),
    ),
  );

  app.delete("/api/v1/oauth-selections/:selectionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const actor = c.get("actor");
        const { routingKey, selectionId } = yield* resolveSelectionRoutingKey(
          c.req.param("selectionId"),
          actor.workspace.id,
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const result = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).cancelSelection(
            selectionId,
            {
              organizationId: actor.workspace.id,
              userId: actor.userId,
            },
            key,
          ),
        );
        if (result.status === "not_found") {
          return yield* Effect.fail(new CoreApiError(404, "not_found", selectionNotFoundMessage));
        }
        if (result.status === "conflict") {
          return yield* Effect.fail(new CoreApiError(409, "invalid_state", result.message));
        }
        return noContentResponse(c.get("requestId"), idempotencyHeaders(false));
      }),
    ),
  );
}
