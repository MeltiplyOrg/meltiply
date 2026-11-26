import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  classifyProviderFailure,
  composeCaption,
  normalizeProviderFailure,
  ProviderAdapterError,
  ProviderService,
  validatePublishInput,
  type ProviderAdapter,
  type ProviderFailure,
  type ProviderMedia,
  type ProviderOperationMetadata,
  type ProviderOperationResult,
  type ProviderPublishOptions,
  type ProviderPublicationStatus,
  type ProviderRegistry,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderTransferMode,
  type PublishInput,
} from "@meltiply/providers";
import {
  executeProviderTokenRefreshEffect,
  hasUsableProviderCredentials,
  safeProviderUrl,
} from "./provider-sync-provider";
import { normalizeIdentifier } from "./validation";

export interface PublicationMediaCandidate {
  contentType: string | null;
  durationSeconds?: number;
  etag?: string;
  fileSize: number;
  height?: number;
  objectId: string;
  objectKey: string;
  width?: number;
}

export interface PublicationMediaEntry {
  assetId: string;
  assetType: "image" | "video";
  candidates: PublicationMediaCandidate[];
  position: number;
}

export interface DistributionPublishTarget {
  connectionStatus: string;
  hashtags: string[];
  idempotencyKey: string;
  media: PublicationMediaEntry[];
  platform: Platform;
  platformAccountId?: string;
  postId: string;
  providerAccountId?: string;
  providerOptions?: ProviderPublishOptions;
  signature?: string | null;
  storedAccessToken: string;
  storedRefreshToken?: string | null;
  textContent: string | null;
  title: string;
  tokenExpiresAt: Date | null;
}

export interface DistributionCancelTarget {
  connectionStatus: string;
  platform: Platform;
  providerAccountId?: string;
  providerOperationId: string | null;
  providerPostId: string | null;
  storedAccessToken: string;
  tokenExpiresAt: Date | null;
}

type DistributionLookupTarget = DistributionCancelTarget & {
  media?: PublicationMediaEntry[];
};

export interface ProviderReplyTarget {
  connectionStatus: string;
  idempotencyKey: string;
  platform: Platform;
  providerAccountId?: string;
  providerCommentId: string;
  storedAccessToken: string;
  text: string;
  tokenExpiresAt: Date | null;
}

interface ProviderMediaRequest {
  assetId: string;
  assetType: "image" | "video";
  contentType: string;
  fileSize: number;
  objectKey: string;
  transferMode: ProviderTransferMode;
}
export interface DistributionProviderDependencies {
  decryptToken: (storedToken: string) => Promise<string>;
  mediaFor?: (request: ProviderMediaRequest) => Promise<ProviderMedia>;
  persistRefreshedTokens?: (rotation: {
    accessToken: string;
    expiresAt?: string;
    platformAccountId: string;
    refreshToken?: string;
    scopes: string[];
  }) => Promise<boolean> | Effect.Effect<boolean, unknown>;
}

export interface DistributionPublishExecution {
  result: ProviderOperationResult;
  retryPolicy?: ProviderRetryPolicy;
}

export type ProviderReplyExecution = DistributionPublishExecution;

type DistributionLookupResult =
  | { kind: "lookup_failure"; failure: ProviderFailure }
  | { kind: "publication"; status: ProviderPublicationStatus };

export interface DistributionLookupExecution {
  metadata?: ProviderOperationMetadata;
  result: DistributionLookupResult;
  retryPolicy?: ProviderRetryPolicy;
}

function failureResult(code: string, status: number): DistributionPublishExecution {
  return {
    result: {
      failure: classifyProviderFailure({ code, status }),
      outcome: "confirmed_failure",
    },
  };
}

function preparationFailure(adapter: ProviderAdapter): DistributionPublishExecution {
  return {
    result: {
      failure: classifyProviderFailure({
        code: "provider_preparation_failed",
      }),
      outcome: "confirmed_failure",
    },
    retryPolicy: adapter.retryPolicy,
  };
}

function frozenCaption(target: DistributionPublishTarget): string {
  return composeCaption({
    defaultText: target.textContent,
    descriptionOverride: null,
    hashtags: target.hashtags,
    signature: target.signature ?? null,
    title: target.title,
    titleOverride: null,
  });
}

function buildPublishInput(
  target: DistributionPublishTarget,
  media: ProviderMedia[],
): PublishInput {
  return {
    caption: frozenCaption(target),
    hashtags: [...target.hashtags],
    idempotencyKey: target.idempotencyKey,
    media,
    ...(target.providerOptions ? { providerOptions: structuredClone(target.providerOptions) } : {}),
  };
}

function preferredTransferMode(adapter: ProviderAdapter): ProviderTransferMode | undefined {
  return (["remote_ingest", "resumable_upload", "byte_upload"] as const).find((candidate) =>
    adapter.transferModes.includes(candidate),
  );
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function candidateProbe(candidate: PublicationMediaCandidate): ProviderMedia {
  return {
    contentType: candidate.contentType ?? "",
    fileSize: candidate.fileSize,
    metadata: {
      ...(candidate.durationSeconds === undefined
        ? {}
        : { durationSeconds: candidate.durationSeconds }),
      ...(candidate.height === undefined ? {} : { height: candidate.height }),
      ...(candidate.width === undefined ? {} : { width: candidate.width }),
    },
    mode: "remote_ingest",
    url: "https://validation.invalid/media",
  };
}

export function candidateConstraint(
  capability: ProviderAdapter["capability"],
  candidate: Pick<
    PublicationMediaCandidate,
    "contentType" | "durationSeconds" | "fileSize" | "height" | "width"
  >,
): string | undefined {
  return validatePublishInput(capability, {
    caption: "",
    hashtags: [],
    idempotencyKey: "distribution-frozen-candidate",
    media: [
      candidateProbe({
        ...candidate,
        objectId: "",
        objectKey: "",
      }),
    ],
  }).find((issue) => issue.field.startsWith("media[0]."))?.constraint;
}

function undeliverableCode(
  capability: ProviderAdapter["capability"],
  entry: PublicationMediaEntry,
): string {
  for (const candidate of entry.candidates) {
    const constraint = candidateConstraint(capability, candidate);
    if (constraint) return constraint;
  }
  return "provider_media_unavailable";
}

function selectCandidate(
  capability: ProviderAdapter["capability"],
  entry: PublicationMediaEntry,
): PublicationMediaCandidate | undefined {
  let best: PublicationMediaCandidate | undefined;
  for (const candidate of entry.candidates) {
    if (candidateConstraint(capability, candidate) !== undefined) continue;
    if (!best || candidate.fileSize < best.fileSize) best = candidate;
  }
  return best;
}

function prepareTarget(
  adapter: ProviderAdapter,
  target: DistributionPublishTarget,
): { code: string } | { media: PublicationMediaCandidate[] } {
  const capability = adapter.capability;
  if (!capability.publish) return { code: "unsupported_capability" };
  if (target.connectionStatus !== "connected") {
    return { code: "provider_reconnect_required" };
  }
  const selected: PublicationMediaCandidate[] = [];
  for (const entry of target.media) {
    const candidate = selectCandidate(capability, entry);
    if (!candidate) return { code: undeliverableCode(capability, entry) };
    selected.push(candidate);
  }
  if (selected.length > 0 && !preferredTransferMode(adapter)) {
    return { code: "provider_media_unavailable" };
  }
  const issue = validatePublishInput(capability, {
    caption: frozenCaption(target),
    hashtags: target.hashtags,
    idempotencyKey: target.idempotencyKey,
    media: selected.map((candidate) => candidateProbe(candidate)),
    ...(target.providerOptions ? { providerOptions: target.providerOptions } : {}),
  })[0];
  if (issue) return { code: issue.constraint };
  return { media: selected };
}

function ambiguousResult(
  code: string,
  providerOperationId?: string,
  metadata?: ProviderOperationMetadata,
) {
  const failure = classifyProviderFailure({
    code,
    sideEffectPossible: true,
  });
  if (failure.classification !== "ambiguous") {
    throw new TypeError("ambiguous provider failure was misclassified");
  }
  return {
    failure: { ...failure, classification: "ambiguous" as const },
    outcome: "unknown" as const,
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function resultFromCaught(cause: unknown, fallbackCode: string): ProviderOperationResult {
  if (cause instanceof ProviderAdapterError) {
    if (cause.failure.code === "provider_unexpected") {
      return ambiguousResult(fallbackCode);
    }
    const failure = normalizeProviderFailure(cause.failure);
    return failure.classification === "ambiguous"
      ? ambiguousResult(failure.code)
      : { failure, outcome: "confirmed_failure" };
  }
  return ambiguousResult(fallbackCode);
}

async function decryptAccessToken(
  decrypt: (storedToken: string) => Promise<string>,
  storedToken: string,
): Promise<string> {
  const accessToken = await decrypt(storedToken);
  if (!accessToken.trim()) throw new TypeError("provider token is empty");
  return accessToken;
}

function normalizeResult(result: ProviderOperationResult): ProviderOperationResult {
  if (result.outcome === "confirmed_failure") {
    return { ...result, failure: normalizeProviderFailure(result.failure) };
  }
  if (result.outcome === "unknown") {
    return ambiguousResult(
      result.failure.code,
      result.providerOperationId?.trim() || undefined,
      result.metadata,
    );
  }
  const providerOperationId = normalizeIdentifier(result.providerOperationId);
  const providerPostId = normalizeIdentifier(result.providerPostId);
  const providerUrl = safeProviderUrl(result.providerUrl);
  const warnings = result.warnings;
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) ||
      warnings.length > 1 ||
      warnings.some(
        (warning) =>
          warning !== "instagram_crossshare_failed" && warning !== "instagram_publish_partial",
      ))
  ) {
    return ambiguousResult(
      "provider_success_with_invalid_warnings",
      providerOperationId,
      result.metadata,
    );
  }
  if (
    (!providerOperationId && !providerPostId) ||
    (result.providerUrl !== undefined && !providerUrl)
  ) {
    return ambiguousResult("provider_success_without_safe_evidence", undefined, result.metadata);
  }
  return {
    outcome: "confirmed_success",
    ...(result.delivery ? { delivery: result.delivery } : {}),
    ...(warnings?.length ? { warnings } : {}),
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(providerPostId ? { providerPostId } : {}),
    ...(providerUrl ? { providerUrl } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function normalizeCancelResult(result: ProviderOperationResult): ProviderOperationResult {
  if (result.outcome !== "confirmed_success") return normalizeResult(result);
  const providerOperationId = normalizeIdentifier(result.providerOperationId);
  const providerPostId = normalizeIdentifier(result.providerPostId);
  const providerUrl = safeProviderUrl(result.providerUrl);
  if (
    (result.providerOperationId !== undefined && !providerOperationId) ||
    (result.providerPostId !== undefined && !providerPostId) ||
    (result.providerUrl !== undefined && !providerUrl)
  ) {
    return ambiguousResult("provider_cancel_without_safe_evidence");
  }
  return {
    outcome: "confirmed_success",
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(providerPostId ? { providerPostId } : {}),
    ...(providerUrl ? { providerUrl } : {}),
  };
}

function normalizePublicationStatus(status: ProviderPublicationStatus): ProviderPublicationStatus {
  switch (status.state) {
    case "processing": {
      const providerOperationId = normalizeIdentifier(status.providerOperationId);
      return providerOperationId
        ? { providerOperationId, state: "processing" }
        : {
            result: ambiguousResult("provider_processing_without_safe_id"),
            state: "unknown",
          };
    }
    case "delivered":
    case "published": {
      const result = normalizeResult(status.result);
      if (result.outcome === "confirmed_success") {
        if (status.state === "delivered" && !result.delivery) {
          return {
            state: "unknown",
            result: ambiguousResult("provider_delivery_without_kind", result.providerOperationId),
          };
        }
        return { result, state: result.delivery ? "delivered" : "published" };
      }
      return result.outcome === "confirmed_failure"
        ? { result, state: "failed" }
        : { result, state: "unknown" };
    }
    case "failed":
      return {
        result: {
          ...status.result,
          failure: normalizeProviderFailure(status.result.failure),
        },
        state: "failed",
      };
    case "unknown":
      return {
        result: ambiguousResult(
          status.result.failure.code,
          status.result.providerOperationId?.trim() || undefined,
        ),
        state: "unknown",
      };
    case "not_found":
      return status;
  }
}

async function resolveMedia(
  adapter: ProviderAdapter,
  entries: PublicationMediaEntry[],
  selected: PublicationMediaCandidate[],
  dependencies: DistributionProviderDependencies,
): Promise<ProviderMedia[]> {
  if (selected.length === 0) return [];
  const transferMode = preferredTransferMode(adapter)!;
  if (!dependencies.mediaFor) {
    throw new TypeError("provider media resolver is unavailable");
  }
  const resolved: ProviderMedia[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index]!;
    const contentType = candidate.contentType!;
    const media = await dependencies.mediaFor({
      assetId: entries[index]!.assetId,
      assetType: entries[index]!.assetType,
      contentType,
      fileSize: candidate.fileSize,
      objectKey: candidate.objectKey,
      transferMode,
    });
    if (
      media.mode !== transferMode ||
      media.contentType.toLowerCase() !== contentType.toLowerCase() ||
      media.fileSize !== candidate.fileSize ||
      (media.mode === "remote_ingest" && !isSecureUrl(media.url))
    ) {
      throw new TypeError("provider media resolver returned mismatched metadata");
    }
    resolved.push({
      ...media,
      metadata: {
        ...(candidate.durationSeconds === undefined
          ? {}
          : { durationSeconds: candidate.durationSeconds }),
        ...(candidate.height === undefined ? {} : { height: candidate.height }),
        ...(candidate.width === undefined ? {} : { width: candidate.width }),
      },
    });
  }
  return resolved;
}

async function continuationMedia(
  adapter: ProviderAdapter,
  target: DistributionLookupTarget,
  providerOperationId: string | undefined,
  dependencies: Pick<DistributionProviderDependencies, "mediaFor">,
): Promise<ProviderMedia | undefined> {
  if (
    providerOperationId === undefined ||
    !dependencies.mediaFor ||
    !adapter.continuesResumableUpload?.(providerOperationId)
  ) {
    return undefined;
  }
  try {
    for (const entry of target.media ?? []) {
      for (const candidate of entry.candidates) {
        if (!candidate.contentType) continue;
        const media = await dependencies.mediaFor({
          assetId: entry.assetId,
          assetType: entry.assetType,
          contentType: candidate.contentType,
          fileSize: candidate.fileSize,
          objectKey: candidate.objectKey,
          transferMode: "resumable_upload",
        });
        if (
          media.mode === "remote_ingest" ||
          media.contentType.toLowerCase() !== candidate.contentType.toLowerCase() ||
          media.fileSize !== candidate.fileSize
        ) {
          continue;
        }
        return media;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function executeProviderPublishEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: DistributionPublishTarget,
  dependencies: DistributionProviderDependencies,
  now = new Date(),
): Effect.Effect<DistributionPublishExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.publish || !adapter.retryPolicy) {
    return Effect.succeed(failureResult("provider_unavailable", 422));
  }
  const prepared = prepareTarget(adapter, target);
  if ("code" in prepared) {
    return Effect.succeed(failureResult(prepared.code, 422));
  }
  const tokenExpired = target.tokenExpiresAt !== null && target.tokenExpiresAt <= now;
  const storedCredential = target.storedRefreshToken || target.storedAccessToken;
  const persist = dependencies.persistRefreshedTokens;
  const refreshable =
    tokenExpired &&
    Boolean(adapter.refreshAccessToken) &&
    Boolean(target.platformAccountId) &&
    storedCredential.trim().length > 0 &&
    persist !== undefined;
  if (tokenExpired && !refreshable) {
    return Effect.succeed(failureResult("provider_reconnect_required", 422));
  }
  return Effect.catch(
    Effect.gen(function* () {
      let refreshedAccessToken: string | undefined;
      if (refreshable) {
        const refreshed = yield* executeProviderTokenRefreshEffect(
          registry,
          context,
          {
            platform: target.platform,
            storedAccessToken: target.storedAccessToken,
            storedRefreshToken: target.storedRefreshToken || null,
          },
          dependencies,
          now,
        );
        if (refreshed.outcome !== "success") {
          return failureResult("provider_reconnect_required", 422);
        }
        const persisted = yield* Effect.suspend(() => {
          const outcome = persist({
            accessToken: refreshed.tokens.accessToken,
            ...(refreshed.tokens.expiresAt !== undefined
              ? { expiresAt: refreshed.tokens.expiresAt }
              : {}),
            platformAccountId: target.platformAccountId!,
            ...(refreshed.tokens.refreshToken
              ? { refreshToken: refreshed.tokens.refreshToken }
              : {}),
            scopes: refreshed.tokens.scopes,
          });
          return Effect.isEffect(outcome) ? Effect.orDie(outcome) : Effect.promise(() => outcome);
        });
        if (!persisted) {
          return failureResult("provider_reconnect_required", 422);
        }
        refreshedAccessToken = refreshed.tokens.accessToken;
      }
      context.metadata = undefined;
      const delivered = yield* Effect.tryPromise({
        catch: () => preparationFailure(adapter),
        try: async () => ({
          accessToken:
            refreshedAccessToken ??
            (await decryptAccessToken(dependencies.decryptToken, target.storedAccessToken)),
          media: await resolveMedia(adapter, target.media, prepared.media, dependencies),
        }),
      });
      const result = yield* Effect.catch(
        Effect.flatMap(ProviderService, (service) =>
          service.publish(
            target.platform,
            context,
            {
              accessToken: delivered.accessToken,
              ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
            },
            buildPublishInput(target, delivered.media),
          ),
        ),
        (cause: unknown) => Effect.succeed(resultFromCaught(cause, "provider_call_failed")),
      );
      const withMetadata = context.metadata ? { ...result, metadata: context.metadata } : result;
      return {
        result: normalizeResult(withMetadata),
        retryPolicy: adapter.retryPolicy,
      };
    }),
    (execution: DistributionPublishExecution) => Effect.succeed(execution),
  );
}

export function executeProviderCancelEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: DistributionCancelTarget,
  dependencies: Pick<DistributionProviderDependencies, "decryptToken">,
  now = new Date(),
): Effect.Effect<DistributionPublishExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.cancelPublication) {
    return Effect.succeed(failureResult("provider_cancel_unavailable", 422));
  }
  if (!hasUsableProviderCredentials(target, now)) {
    return Effect.succeed(failureResult("provider_reconnect_required", 401));
  }
  if (!target.providerOperationId && !target.providerPostId) {
    return Effect.succeed(failureResult("provider_cancel_lookup_unavailable", 422));
  }
  context.metadata = undefined;
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise({
        catch: () => preparationFailure(adapter),
        try: () => decryptAccessToken(dependencies.decryptToken, target.storedAccessToken),
      });
      const result = yield* Effect.catch(
        Effect.flatMap(ProviderService, (service) =>
          service.cancelPublication(
            target.platform,
            context,
            {
              accessToken,
              ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
            },
            {
              ...(target.providerOperationId
                ? { providerOperationId: target.providerOperationId }
                : {}),
              ...(target.providerPostId ? { providerPostId: target.providerPostId } : {}),
            },
          ),
        ),
        (cause: unknown) => Effect.succeed(resultFromCaught(cause, "provider_cancel_failed")),
      );
      return {
        result: normalizeCancelResult(result),
        retryPolicy: adapter.retryPolicy,
      };
    }),
    (execution: DistributionPublishExecution) => Effect.succeed(execution),
  );
}

export function executeProviderReplyEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: ProviderReplyTarget,
  dependencies: Pick<DistributionProviderDependencies, "decryptToken">,
  now = new Date(),
): Effect.Effect<ProviderReplyExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.reply || !adapter.retryPolicy) {
    return Effect.succeed(failureResult("provider_reply_unavailable", 422));
  }
  if (!hasUsableProviderCredentials(target, now)) {
    return Effect.succeed({
      ...failureResult("provider_reconnect_required", 401),
      retryPolicy: adapter.retryPolicy,
    });
  }
  const providerCommentId = normalizeIdentifier(target.providerCommentId);
  const text = target.text.trim();
  if (
    !providerCommentId ||
    !normalizeIdentifier(target.idempotencyKey) ||
    text.length === 0 ||
    text.length > 10_000
  ) {
    return Effect.succeed({
      ...failureResult("provider_reply_invalid", 422),
      retryPolicy: adapter.retryPolicy,
    });
  }
  context.metadata = undefined;
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise({
        catch: () => preparationFailure(adapter),
        try: () => decryptAccessToken(dependencies.decryptToken, target.storedAccessToken),
      });
      const result = yield* Effect.catch(
        Effect.flatMap(ProviderService, (service) =>
          service.reply(
            target.platform,
            context,
            {
              accessToken,
              ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
            },
            {
              idempotencyKey: target.idempotencyKey,
              providerCommentId,
              text,
            },
          ),
        ),
        (cause: unknown) => Effect.succeed(resultFromCaught(cause, "provider_reply_failed")),
      );
      const withMetadata = context.metadata ? { ...result, metadata: context.metadata } : result;
      return {
        result: normalizeResult(withMetadata),
        retryPolicy: adapter.retryPolicy,
      };
    }),
    (execution: ProviderReplyExecution) => Effect.succeed(execution),
  );
}

function lookupFailure(
  code: string,
  status?: number,
  retryPolicy?: ProviderRetryPolicy,
): DistributionLookupExecution {
  return {
    result: {
      failure: classifyProviderFailure({ code, ...(status === undefined ? {} : { status }) }),
      kind: "lookup_failure",
    },
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

export function executeProviderLookupEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: DistributionLookupTarget,
  dependencies: Pick<DistributionProviderDependencies, "decryptToken" | "mediaFor">,
  now = new Date(),
): Effect.Effect<DistributionLookupExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.lookupPublication) {
    return Effect.succeed(lookupFailure("provider_lookup_unavailable", 422));
  }
  if (!hasUsableProviderCredentials(target, now)) {
    return Effect.succeed(lookupFailure("provider_reconnect_required", 401, adapter.retryPolicy));
  }
  const providerOperationId = target.providerOperationId
    ? normalizeIdentifier(target.providerOperationId)
    : undefined;
  const providerPostId = target.providerPostId
    ? normalizeIdentifier(target.providerPostId)
    : undefined;
  if (
    (!providerOperationId && !providerPostId) ||
    (target.providerOperationId !== null && !providerOperationId) ||
    (target.providerPostId !== null && !providerPostId)
  ) {
    return Effect.succeed(
      lookupFailure("provider_lookup_evidence_unavailable", 422, adapter.retryPolicy),
    );
  }

  context.metadata = undefined;
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise<string, DistributionLookupExecution>({
        catch: () => lookupFailure("provider_preparation_failed", undefined, adapter.retryPolicy),
        try: () => decryptAccessToken(dependencies.decryptToken, target.storedAccessToken),
      });
      const media = yield* Effect.promise(() =>
        continuationMedia(adapter, target, providerOperationId, dependencies),
      );
      const rawStatus = yield* Effect.flatMap(ProviderService, (service) =>
        service.lookupPublication(
          target.platform,
          context,
          {
            accessToken,
            ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
          },
          {
            ...(media ? { media } : {}),
            ...(providerOperationId ? { providerOperationId } : {}),
            ...(providerPostId ? { providerPostId } : {}),
          },
        ),
      ).pipe(
        Effect.mapError((cause: unknown): DistributionLookupExecution => ({
          result: {
            failure:
              cause instanceof ProviderAdapterError && cause.failure.code !== "provider_unexpected"
                ? normalizeProviderFailure(cause.failure)
                : classifyProviderFailure({ code: "provider_lookup_failed" }),
            kind: "lookup_failure",
          },
          retryPolicy: adapter.retryPolicy,
        })),
      );
      const status = normalizePublicationStatus(rawStatus);
      return {
        result: {
          kind: "publication" as const,
          status: context.metadata ? { ...status, metadata: context.metadata } : status,
        },
        metadata: context.metadata,
        retryPolicy: adapter.retryPolicy,
      };
    }),
    (execution: DistributionLookupExecution) => Effect.succeed(execution),
  );
}
