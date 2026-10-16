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
import { executeProviderTokenRefreshEffect } from "./provider-sync-provider";
import { normalizeIdentifier } from "./validation";

/**
 * One verified, ready object a frozen publication attempt may deliver for an
 * attachment. Ids and keys are captured at claim so later Post or rendition
 * changes cannot alter the attempt; `objectKey` is `<org>/<asset_id>/<file>`.
 */
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

/**
 * One ordered attachment of a frozen publication attempt. `candidates` holds
 * every ready object captured at claim; the capability fit decides which one
 * is delivered, preferring the smallest verified output.
 */
export interface PublicationMediaEntry {
  assetId: string;
  assetType: "image" | "video";
  candidates: PublicationMediaCandidate[];
  position: number;
}

/**
 * Publication input for one Provider attempt: content and media already
 * resolved and frozen at claim, plus the credentials and Platform identity the
 * adapter needs. Overrides and Post defaults are resolved by the caller so the
 * adapter never reads live composition state.
 */
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

/**
 * Reconciliation lookup target: the cancel fields plus the frozen media
 * entries needed to replay bytes for an adapter that declares
 * `continuesResumableUpload`. Media stays optional so a lookup without a
 * usable snapshot (or a text-only Post) keeps the plain status path.
 */
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

/**
 * One attachment's resolution request. `objectKey` is the frozen ready
 * rendition (or verified original) captured at claim; the resolver re-reads
 * R2 metadata and only then issues scoped delivery.
 */
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
  /**
   * Atomically persists a just-in-time token rotation for the target's platform
   * account: encrypts the rotated credentials and updates access token, refresh
   * token, expiry, and refresh-attempt state in one write. Resolves false when
   * the account row no longer matches the credential snapshot the publish read,
   * so the caller must not publish with unpersisted rotated credentials (#256).
   */
  persistRefreshedTokens?: (rotation: {
    accessToken: string;
    expiresAt?: string;
    platformAccountId: string;
    refreshToken?: string;
    scopes: string[];
  }) => Promise<boolean>;
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

/**
 * Constructs a confirmed failure execution result from an error code and HTTP status.
 *
 * @param code - Error diagnostic code.
 * @param status - Numeric HTTP status code.
 * @returns DistributionPublishExecution with classified confirmed_failure outcome.
 */
function failureResult(code: string, status: number): DistributionPublishExecution {
  return {
    result: {
      failure: classifyProviderFailure({ code, status }),
      outcome: "confirmed_failure",
    },
  };
}

/**
 * Builds the preparation-failure execution when credential decryption or media
 * resolution throws. Preparation throws prove nothing about the remote side,
 * so they surface as deterministic confirmed failures, never ambiguous.
 *
 * @param adapter - Target platform provider adapter.
 * @returns DistributionPublishExecution with classified confirmed_failure outcome.
 */
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

/**
 * Composes the caption a frozen target publishes.
 *
 * Pre-flight validation and the adapter call must send byte-identical
 * captions, so both derive it from the snapshot's already-resolved title and
 * text rather than re-applying overrides here.
 *
 * @param target - Frozen publication target.
 * @returns The composed caption including hashtags.
 */
function frozenCaption(target: DistributionPublishTarget): string {
  // Overrides were already merged into the target when the snapshot froze,
  // so the composed caption feeds Post defaults with no further override.
  return composeCaption({
    defaultText: target.textContent,
    descriptionOverride: null,
    hashtags: target.hashtags,
    title: target.title,
    titleOverride: null,
  });
}

/**
 * Builds the provider publish input from a frozen target and its resolved,
 * capability-selected media.
 *
 * The caption is composed once from the frozen Post text and target hashtags so
 * pre-flight validation and the adapter call cannot drift. Media is the ordered
 * `ProviderMedia[]` the contract requires: an empty array is a text-only
 * publication, and each item keeps the verified dimensions/duration of the
 * rendition chosen for it.
 *
 * @param target - Frozen publication target (content already resolved).
 * @param media - Resolved media in attachment order; empty for text-only Posts.
 * @returns PublishInput for the adapter call.
 */
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

/**
 * Resolves the preferred media transfer mode supported by a provider adapter.
 * Prioritizes remote_ingest (zero-egress Cloudflare R2 presigned URLs), followed by resumable_upload and byte_upload.
 *
 * @param adapter - Provider adapter instance.
 * @returns Best supported ProviderTransferMode, or undefined if none supported.
 */
function preferredTransferMode(adapter: ProviderAdapter): ProviderTransferMode | undefined {
  return (["remote_ingest", "resumable_upload", "byte_upload"] as const).find((candidate) =>
    adapter.transferModes.includes(candidate),
  );
}

/**
 * Validates that a URL string uses HTTPS and contains no inline credentials.
 *
 * @param value - Candidate URL string.
 * @returns True if value is a valid secure HTTPS URL.
 */
function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Sanitizes an external publication URL returned by a provider.
 * Enforces HTTPS, rejects embedded user/password credentials, and strips query parameters and hashes.
 *
 * @param value - Candidate provider URL.
 * @returns Cleaned URL string, or undefined if invalid.
 */
function safeProviderUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Presents one frozen object to the shared capability validator.
 *
 * The probe carries a placeholder delivery URL plus the object's verified
 * stored facts, because only the MIME type, byte length, and per-item metadata
 * decide an object's fit; the constraints about the attempt as a whole
 * (caption, hashtags, attachment set) are owned by the caller. `contentType`
 * falls back to an empty string so an object that never recorded its media type
 * is rejected as unsupported instead of skipped by the probe.
 *
 * @param candidate - Frozen ready object to probe.
 * @returns Provider media descriptor the shared validator can evaluate.
 */
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

/**
 * Reports the Platform constraint one frozen object violates, or undefined when
 * the object can be delivered.
 *
 * Fit is decided by the shared `validatePublishInput` rules rather than a
 * second copy of them, so the claim-time freeze and this pre-flight check can
 * never disagree about a MIME type, attachable kind, byte ceiling, or video
 * duration. Only the single probed object is evaluated, so attachment-set
 * issues about the attempt as a whole are ignored.
 *
 * @param capability - Target Platform capability the object must satisfy.
 * @param candidate - Frozen ready object with its verified stored facts.
 * @returns The violated constraint name, or undefined when the object fits.
 */
function candidateConstraint(
  capability: ProviderAdapter["capability"],
  candidate: PublicationMediaCandidate,
): string | undefined {
  return validatePublishInput(capability, {
    caption: "",
    hashtags: [],
    idempotencyKey: "distribution-frozen-candidate",
    media: [candidateProbe(candidate)],
  }).find((issue) => issue.field.startsWith("media[0]."))?.constraint;
}

/**
 * Reports why one frozen attachment cannot be delivered: the constraint that
 * rejected every frozen object it holds, or unavailable media when the attempt
 * froze no object for it at all.
 *
 * Selection treats an object violating a capability constraint as
 * undeliverable, so an object that only misses a MIME, byte, or duration limit
 * would otherwise be reported as missing media; surfacing the shared
 * validator's own constraint keeps the failure actionable (and identical to
 * what the claim-time freeze rejected it for).
 *
 * @param capability - Target Platform capability the objects must satisfy.
 * @param entry - Frozen attachment entry with its ready candidates.
 * @returns Failure code naming the violated constraint or unavailable media.
 */
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

/**
 * Picks the object delivered for one attachment from the candidates frozen at
 * claim. A verified rendition is preferred over the original whenever both
 * fit (issue #284: prefer a smaller validated output), and the smallest
 * fitting candidate wins, so the choice is deterministic for a given
 * capability and never mixes content.
 * Fit itself comes from the shared capability validator, so this choice can
 * never disagree with the claim-time freeze that produced these candidates or
 * with the pre-flight check of the selected set.
 *
 * @param capability - Target Platform capability the object must satisfy.
 * @param entry - Frozen attachment entry with its ready candidates.
 * @returns Best fitting candidate, or undefined when none can be delivered.
 */
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

/**
 * Selects the deliverable object for every frozen attachment, then validates
 * the resulting publication against Platform capability before any Provider
 * side effect.
 *
 * Selection runs first because its answer is what must be validated: an
 * attachment with no object this Platform accepts cannot be published, and the
 * shared validator's own constraint names why (byte, duration, or MIME limit),
 * falling back to unavailable media only when the attempt froze no object for
 * the attachment at all. Token expiry is deliberately excluded — the caller
 * resolves an expired token through the just-in-time refresh path before this
 * outcome is final (#256).
 *
 * @param adapter - Target platform provider adapter.
 * @param target - Frozen publication target (content and media resolved at claim).
 * @returns Selected media in attachment order, or an error code string.
 */
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
  // Pre-flight uses placeholder delivery URLs and per-item metadata only: the
  // shared validator evaluates caption, hashtag, media and provider-option
  // constraints, none of which depend on a signed URL.
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

/**
 * Constructs an ambiguous operation result indicating an unknown provider outcome where side effects may have occurred.
 *
 * @param code - Error code classification.
 * @param providerOperationId - Optional asynchronous operation ID returned by the provider.
 * @param metadata - Optional operation telemetry or rate limit metadata.
 * @returns ProviderOperationResult with outcome "unknown" and ambiguous classification.
 * @throws {TypeError} If failure classification does not resolve to ambiguous.
 */
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

/**
 * Maps a thrown provider error to a standardized operation result.
 * Normalized adapter failures with ambiguous classification become unknown outcomes;
 * other caught exceptions map to an unknown result under `fallbackCode`.
 *
 * @param cause - Thrown error value.
 * @param fallbackCode - Default diagnostic error code.
 * @returns Standardized ProviderOperationResult.
 */
function resultFromCaught(cause: unknown, fallbackCode: string): ProviderOperationResult {
  if (cause instanceof ProviderAdapterError) {
    // Unexpected adapter failure cannot prove that a dispatched write did not commit.
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

/**
 * Decrypts a stored provider access token and verifies it is non-empty.
 *
 * @param decrypt - Decryption function.
 * @param storedToken - Encrypted cipher text.
 * @returns Plaintext access token string.
 * @throws {TypeError} When decrypted token is empty or whitespace.
 */
async function decryptAccessToken(
  decrypt: (storedToken: string) => Promise<string>,
  storedToken: string,
): Promise<string> {
  const accessToken = await decrypt(storedToken);
  if (!accessToken.trim()) throw new TypeError("provider token is empty");
  return accessToken;
}

/**
 * Normalizes provider operation results, enforcing identifier sanitation and URL safety.
 * Degrades confirmed successes lacking both operation ID and post ID to ambiguous outcomes.
 *
 * @param result - Raw ProviderOperationResult from an adapter.
 * @returns Normalized ProviderOperationResult with sanitized fields.
 */
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
  if (
    (!providerOperationId && !providerPostId) ||
    (result.providerUrl !== undefined && !providerUrl)
  ) {
    return ambiguousResult("provider_success_without_safe_evidence", undefined, result.metadata);
  }
  return {
    outcome: "confirmed_success",
    ...(providerOperationId ? { providerOperationId } : {}),
    ...(providerPostId ? { providerPostId } : {}),
    ...(providerUrl ? { providerUrl } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

/**
 * Normalizes results from a provider cancelPublication operation.
 * Verifies that cancel successes provide valid sanitized identifiers or URLs.
 *
 * @param result - Raw ProviderOperationResult from cancel call.
 * @returns Normalized ProviderOperationResult.
 */
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

/**
 * Normalizes publication lookup status responses into standardized states:
 * "processing", "published", "failed", "unknown", or "not_found".
 *
 * @param status - Raw ProviderPublicationStatus from adapter lookup.
 * @returns Normalized ProviderPublicationStatus.
 */
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
    case "published": {
      const result = normalizeResult(status.result);
      if (result.outcome === "confirmed_success") {
        return { result, state: "published" };
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

/**
 * Resolves ordered media for publication through the configured resolver.
 *
 * Every attachment is resolved independently and sequentially so the frozen
 * order is preserved and no upload work starts concurrently. Each resolved
 * item must match the transfer mode, MIME type, and byte length frozen at
 * claim; the verified dimensions and duration ride along as per-item metadata
 * so capability checks and the adapter see the same facts.
 *
 * @param adapter - Provider adapter determining the preferred transfer mode.
 * @param entries - Frozen attachment entries in publication order.
 * @param selected - The candidate chosen for each entry, index-aligned.
 * @param dependencies - Provider dependencies with the mediaFor resolver.
 * @returns Resolved ProviderMedia list in attachment order; [] for text-only.
 * @throws {TypeError} If the resolver is missing or returns mismatched metadata.
 */
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

/**
 * Resolves replayable media for a reconciliation lookup only when the
 * adapter's `continuesResumableUpload` predicate accepts the retained
 * operation identity — the narrow seam that lets a persisted resumable
 * session resume inside `lookupPublication` instead of polling until expiry.
 *
 * Only adapters that accept a single media file can resume, so replay walks
 * the frozen entries and asks the resolver for `resumable_upload` bytes that
 * must match a candidate's MIME type and byte length. Any resolver or
 * predicate failure degrades to `undefined` so the lookup falls back to the
 * read-only status probe rather than burning the reconciliation budget on a
 * preparation error.
 *
 * @param adapter - Provider adapter being reconciled.
 * @param target - Lookup target carrying the frozen media entries.
 * @param providerOperationId - Normalized retained operation identity.
 * @param dependencies - Provider dependencies with the mediaFor resolver.
 * @returns ProviderMedia for the lookup, or undefined to keep the plain probe.
 */
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

/**
 * Executes a publication request against a target social platform via the Effect provider service.
 * Handles credential decryption, media asset resolution, capability checks, caption composition,
 * provider invocation, rate-limit metadata capture, and result normalization.
 *
 * When the stored access token is already expired, a just-in-time refresh runs
 * before any publish only while every safety precondition holds: the adapter
 * supports refresh, a stored refresh credential exists (falling back to the
 * access token for providers whose access token is its own refresh secret), and
 * an atomic persistence dependency is configured. Rotated credentials must be
 * persisted (with optional expiry) before the publish call — publishing with an
 * unpersisted rotation could strand the account once the provider invalidates the old
 * refresh credential — so any unavailable, failed, or unpersisted refresh yields the
 * safe `provider_reconnect_required` failure without a publish (#256).
 *
 * @param registry - Provider adapter registry.
 * @param context - Request context for tracing and idempotency.
 * @param target - Publish target containing asset data and credentials.
 * @param dependencies - Injected token decrypter, media resolver, and rotation persister.
 * @param now - Reference timestamp (default Date.now).
 * @returns DistributionPublishExecution containing normalized outcome and retry policy.
 */
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
        const persisted = yield* Effect.promise(() =>
          persist({
            accessToken: refreshed.tokens.accessToken,
            ...(refreshed.tokens.expiresAt !== undefined
              ? { expiresAt: refreshed.tokens.expiresAt }
              : {}),
            platformAccountId: target.platformAccountId!,
            ...(refreshed.tokens.refreshToken
              ? { refreshToken: refreshed.tokens.refreshToken }
              : {}),
            scopes: refreshed.tokens.scopes,
          }),
        );
        // A rejected persist defects to the job boundary for retry; a false
        // return means a concurrent rotation won the row, so publishing with
        // these unpersisted credentials is unsafe — fail to reconnect (#256).
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

/**
 * Executes a publication cancellation against the target platform provider adapter.
 * Re-validates account connection and token expiration, invokes the provider service cancelPublication,
 * and normalizes the cancellation outcome.
 *
 * @param registry - Provider adapter registry.
 * @param context - Request context for tracing and idempotency.
 * @param target - Cancellation target containing operation/post IDs and credentials.
 * @param dependencies - Dependencies containing token decrypter.
 * @param now - Reference timestamp (default Date.now).
 * @returns DistributionPublishExecution with normalized cancellation outcome.
 */
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
  if (
    target.connectionStatus !== "connected" ||
    (target.tokenExpiresAt !== null && target.tokenExpiresAt <= now)
  ) {
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

/**
 * Dispatches a comment reply to the target platform provider adapter.
 * Validates text length (up to 10,000 characters) and comment identifier, invokes the provider service `reply`,
 * and normalizes the response evidence.
 *
 * @param registry - Provider adapter registry.
 * @param context - Request context for tracing and idempotency.
 * @param target - Reply target containing provider comment ID, text, and credentials.
 * @param dependencies - Dependencies containing token decrypter.
 * @param now - Reference timestamp (default Date.now).
 * @returns ProviderReplyExecution with normalized outcome.
 */
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
  if (
    target.connectionStatus !== "connected" ||
    (target.tokenExpiresAt !== null && target.tokenExpiresAt <= now)
  ) {
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

/**
 * Polls or reconciles the publication status of an asynchronous provider operation.
 * Invokes the provider service lookupPublication with sanitized provider operation ID or post ID,
 * returning normalized publication status ("processing", "published", "failed", "unknown", "not_found").
 * Uses the caller's ProviderService layer; the registry only supplies capability
 * checks and retry policy, never a replacement execution service.
 * When the adapter declares `continuesResumableUpload` for the retained
 * operation identity and the target carries complete Asset descriptors, the
 * original media is resolved and passed through `lookup.media` so a persisted
 * resumable session can resume in place; every other lookup stays read-only.
 *
 * @param registry - Provider adapter registry.
 * @param context - Request context for tracing and idempotency.
 * @param target - Lookup target with operation/post IDs and account credentials.
 * @param dependencies - Dependencies containing token decrypter and media resolver.
 * @param now - Reference timestamp (default Date.now).
 * @returns DistributionLookupExecution with normalized status or failure.
 */
export function executeProviderLookupEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: DistributionLookupTarget,
  dependencies: Pick<DistributionProviderDependencies, "decryptToken" | "mediaFor">,
  now = new Date(),
): Effect.Effect<DistributionLookupExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.lookupPublication) {
    return Effect.succeed({
      result: {
        failure: classifyProviderFailure({
          code: "provider_lookup_unavailable",
          status: 422,
        }),
        kind: "lookup_failure",
      },
    });
  }
  if (
    target.connectionStatus !== "connected" ||
    (target.tokenExpiresAt !== null && target.tokenExpiresAt <= now)
  ) {
    return Effect.succeed({
      result: {
        failure: classifyProviderFailure({
          code: "provider_reconnect_required",
          status: 401,
        }),
        kind: "lookup_failure",
      },
      retryPolicy: adapter.retryPolicy,
    });
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
    return Effect.succeed<DistributionLookupExecution>({
      result: {
        failure: classifyProviderFailure({
          code: "provider_lookup_evidence_unavailable",
          status: 422,
        }),
        kind: "lookup_failure",
      },
      retryPolicy: adapter.retryPolicy,
    });
  }

  context.metadata = undefined;
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise<string, DistributionLookupExecution>({
        catch: (): DistributionLookupExecution => ({
          result: {
            failure: classifyProviderFailure({
              code: "provider_preparation_failed",
            }),
            kind: "lookup_failure",
          },
          retryPolicy: adapter.retryPolicy,
        }),
        try: () => decryptAccessToken(dependencies.decryptToken, target.storedAccessToken),
      });
      // Continuation media resolves only for adapters that accept the retained
      // operation identity; any resolver failure degrades to a plain probe.
      const media = yield* Effect.promise(() =>
        continuationMedia(adapter, target, providerOperationId, dependencies),
      );
      const lookup = yield* Effect.map(
        Effect.catch(
          Effect.flatMap(ProviderService, (service) =>
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
          ),
          (cause: unknown) =>
            Effect.fail(
              cause instanceof ProviderAdapterError && cause.failure.code !== "provider_unexpected"
                ? normalizeProviderFailure(cause.failure)
                : classifyProviderFailure({
                    code: "provider_lookup_failed",
                  }),
            ),
        ),
        (status: ProviderPublicationStatus) => ({ ok: true as const, status }),
      ).pipe(
        Effect.catch((failure: ProviderFailure) => Effect.succeed({ failure, ok: false as const })),
      );
      if (!lookup.ok) {
        return {
          result: { failure: lookup.failure, kind: "lookup_failure" as const },
          retryPolicy: adapter.retryPolicy,
        };
      }
      const status = normalizePublicationStatus(lookup.status);
      return {
        result: {
          kind: "publication",
          status: context.metadata ? { ...status, metadata: context.metadata } : status,
        },
        metadata: context.metadata,
        retryPolicy: adapter.retryPolicy,
      };
    }),
    (execution: DistributionLookupExecution) => Effect.succeed(execution),
  );
}
