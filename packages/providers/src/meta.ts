import type { components } from "@meltiply/contracts/schema";

import { isHttp404, malformed, ProviderAdapterError, rejection } from "./failures";
import type { ProviderHttpClient } from "./http";
import { addSeconds } from "./oauth";
import { confirmedFailure, unknownResult } from "./results";
import type {
  ProviderCommentRecord,
  ProviderCredentials,
  ProviderPage,
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  ProviderReplyInput,
  ProviderRequestContext,
} from "./types";
import {
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  metricValue,
  optionalSecureUrl,
  providerIdentifier,
  record,
  requireIdempotencyKey,
  secureUrl,
  timestamp,
} from "./values";

export const META_GRAPH_API_VERSION = "v25.0";

const containerOperationPattern = /^(created|submitted):(.+)$/;
const maxInsightMetrics = 20;
const maxCommentChars = 10_000;

/**
 * `created` awaits the single finalizing publish; `submitted` means a publish was
 * already dispatched, so reconciliation must never publish it again.
 */
export interface MetaContainerOperation {
  id: string;
  phase: "created" | "submitted";
}

export function containerOperationId(phase: MetaContainerOperation["phase"], id: string): string {
  return `${phase}:${id}`;
}

export function parseContainerOperationId(value: unknown): MetaContainerOperation | undefined {
  const match = providerIdentifier(value)?.match(containerOperationPattern);
  const phase = match?.[1];
  const id = providerIdentifier(match?.[2]);
  if (!id || (phase !== "created" && phase !== "submitted")) return undefined;
  return { id, phase };
}

export function insightValue(metric: Record<string, unknown>): number | undefined {
  const values = metric.values;
  if (Array.isArray(values)) return metricValue(record(values[0])?.value);
  return metricValue(record(metric.total_value)?.value);
}

/** `singleValue` requires a single `values` bucket (Facebook Video Insights). */
export function parseMetaInsightsMap(
  body: unknown,
  options: { singleValue?: boolean } = {},
): Map<string, number> {
  const data = record(body)?.data;
  if (!Array.isArray(data) || data.length > maxInsightMetrics) throw malformed();
  const metrics = new Map<string, number>();
  for (const entry of data) {
    const metric = record(entry);
    const name = boundedString(metric?.name, 64);
    if (options.singleValue && (!Array.isArray(metric?.values) || metric.values.length !== 1)) {
      throw malformed();
    }
    const value = metric ? insightValue(metric) : undefined;
    if (!name || value === undefined || metrics.has(name)) throw malformed();
    metrics.set(name, value);
  }
  return metrics;
}

export interface MetaCommentAuthorMapping {
  avatarField?: string;
  nestedAuthorField?: string;
  usernameField: string;
}

export function parseMetaCommentPage(
  bodyValue: unknown,
  providerPostId: string,
  limit: number,
  authorMapping: MetaCommentAuthorMapping,
): ProviderPage<ProviderCommentRecord> {
  const body = record(bodyValue);
  if (!Array.isArray(body?.data) || body.data.length > limit) throw malformed();
  const identifiers = new Set<string>();
  const items = body.data.map((value): ProviderCommentRecord => {
    const comment = record(value);
    const author = authorMapping.nestedAuthorField
      ? record(comment?.[authorMapping.nestedAuthorField])
      : comment;
    const providerCommentId = providerIdentifier(comment?.id);
    const bodyText = boundedText(comment?.text, maxCommentChars, true);
    const commentedAt = timestamp(comment?.timestamp);
    const rawUsername = author?.[authorMapping.usernameField];
    const authorDisplayName =
      rawUsername === undefined ? undefined : boundedString(rawUsername, 500);
    const avatar = optionalSecureUrl(
      authorMapping.avatarField ? comment?.[authorMapping.avatarField] : undefined,
    );
    if (
      !providerCommentId ||
      identifiers.has(providerCommentId) ||
      bodyText === undefined ||
      !commentedAt ||
      (rawUsername !== undefined && !authorDisplayName) ||
      !avatar.valid
    ) {
      throw malformed();
    }
    identifiers.add(providerCommentId);
    return {
      ...(avatar.href ? { authorAvatarUrl: avatar.href } : {}),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      body: bodyText,
      commentedAt,
      providerCommentId,
      providerPostId,
    };
  });
  const paging = record(body.paging);
  const cursors = record(paging?.cursors);
  if ((body.paging !== undefined && !paging) || (paging?.cursors !== undefined && !cursors)) {
    throw malformed();
  }
  const rawNextCursor = cursors?.after;
  const nextCursor = rawNextCursor === undefined ? undefined : boundedCursor(rawNextCursor);
  if (rawNextCursor !== undefined && !nextCursor) throw malformed();
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

export function parseMetaReply(
  input: ProviderReplyInput,
  maxChars: number,
): { providerCommentId: string; text: string } | undefined {
  requireIdempotencyKey(input.idempotencyKey);
  const providerCommentId = providerIdentifier(input.providerCommentId);
  const text = boundedText(input.text.trim(), maxChars);
  return providerCommentId && text ? { providerCommentId, text } : undefined;
}

export interface MetaTokenLimits {
  tokenLifetimeMaxSeconds: number;
  tokenMaxChars: number;
}

/** Instagram and Threads exchange and refresh long-lived tokens through GET query grants. */
export async function requestMetaBearerToken(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  endpoint: string,
  parameters: Readonly<Record<string, string>>,
  limits: MetaTokenLimits,
  now: Date,
): Promise<{ accessToken: string; expiresAt: string }> {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  const response = await http.request(context, { method: "GET", url: url.toString() });
  const body = record(response.body);
  const accessToken = boundedString(body?.access_token, limits.tokenMaxChars);
  if (!accessToken || boundedString(body?.token_type, 32)?.toLowerCase() !== "bearer") {
    throw malformed();
  }
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, limits.tokenLifetimeMaxSeconds),
  };
}

export async function lookupMetaPost(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  lookup: ProviderPublicationLookup & { providerPostId: string },
  url: URL,
  permalink: "required" | "optional",
): Promise<ProviderPublicationStatus> {
  url.searchParams.set("fields", "id,permalink");
  let response;
  try {
    response = await http.request(context, {
      headers: bearer(credentials.accessToken),
      method: "GET",
      url: url.toString(),
    });
  } catch (cause) {
    if (isHttp404(cause)) return { state: "not_found" };
    throw cause;
  }
  const body = record(response.body);
  const providerUrl = secureUrl(body?.permalink)?.href;
  if (
    providerIdentifier(body?.id) !== lookup.providerPostId ||
    (!providerUrl && (permalink === "required" || body?.permalink !== undefined))
  ) {
    throw malformed();
  }
  const providerOperationId = providerIdentifier(lookup.providerOperationId);
  return {
    result: {
      outcome: "confirmed_success",
      ...(providerOperationId ? { providerOperationId } : {}),
      providerPostId: lookup.providerPostId,
      ...(providerUrl ? { providerUrl } : {}),
    },
    state: "published",
  };
}

export async function createMetaContainer(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  accessToken: string,
  url: URL,
  parameters: URLSearchParams,
): Promise<string> {
  url.search = parameters.toString();
  const response = await http.request(context, {
    headers: bearer(accessToken),
    method: "POST",
    url: url.toString(),
  });
  const containerId = providerIdentifier(record(response.body)?.id);
  if (!containerId) throw malformed();
  return containerId;
}

type ProviderWarnings = components["schemas"]["Distribution"]["provider_warnings"];

export interface MetaContainerProtocol {
  containerReadUrl: (containerId: string) => string;
  extractWarnings: (body: Record<string, unknown>) => ProviderWarnings | undefined;
  failureDetailField: "status" | "error_message";
  provider: "instagram" | "threads";
  publishUrl: (credentials: ProviderCredentials, containerId: string) => string;
  publishedOperationPhase: "retain" | "submitted";
  statusField: "status_code" | "status";
}

const containerFailurePatterns: ReadonlyArray<readonly [pattern: RegExp, category: string]> = [
  [/fetch|retrieve(?:d|ing)?|retrieval|download|url|unreach|access/i, "media_retrieval"],
  [/duration|too short|too long|length/i, "media_duration"],
  [/dimension|aspect|resolution|width|height/i, "media_dimensions"],
  [/format|codec|encoding|unsupported|invalid media|corrupt/i, "media_format"],
];

function containerFailureCode(provider: string, detail: unknown): string {
  const text = boundedString(detail, 1_024);
  const category =
    (text && containerFailurePatterns.find(([pattern]) => pattern.test(text))?.[1]) ?? "error";
  return `${provider}_container_${category}`;
}

export async function readMetaContainer(
  http: ProviderHttpClient,
  protocol: MetaContainerProtocol,
  context: ProviderRequestContext,
  accessToken: string,
  containerId: string,
): Promise<Record<string, unknown> | undefined> {
  let response;
  try {
    response = await http.request(context, {
      headers: bearer(accessToken),
      method: "GET",
      url: protocol.containerReadUrl(containerId),
    });
  } catch (cause) {
    if (isHttp404(cause)) return undefined;
    throw cause;
  }
  const body = record(response.body);
  if (providerIdentifier(body?.id) !== containerId) throw malformed();
  return body;
}

async function finalizeMetaContainer(
  http: ProviderHttpClient,
  protocol: MetaContainerProtocol,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  containerId: string,
): Promise<ProviderPublicationStatus> {
  const createdOperationId = containerOperationId("created", containerId);
  try {
    const response = await http.request(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      sideEffectPossible: true,
      url: protocol.publishUrl(credentials, containerId),
    });
    const body = record(response.body);
    const providerPostId = providerIdentifier(body?.id);
    if (!body || !providerPostId) throw malformed(true);
    const warnings = protocol.extractWarnings(body);
    return {
      result: {
        outcome: "confirmed_success",
        providerOperationId: createdOperationId,
        providerPostId,
        ...(warnings ? { warnings } : {}),
      },
      state: "published",
    };
  } catch (cause) {
    if (!(cause instanceof ProviderAdapterError)) throw cause;
    if (cause.failure.classification === "ambiguous") {
      return {
        result: unknownResult(cause.failure.code, containerOperationId("submitted", containerId)),
        state: "unknown",
      };
    }
    if (cause.failure.retryable) {
      return { providerOperationId: createdOperationId, state: "processing" };
    }
    return { result: confirmedFailure(cause.failure, createdOperationId), state: "failed" };
  }
}

export async function lookupMetaContainer(
  http: ProviderHttpClient,
  protocol: MetaContainerProtocol,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  operation: MetaContainerOperation,
): Promise<ProviderPublicationStatus> {
  const retainedOperationId = containerOperationId(operation.phase, operation.id);
  const body = await readMetaContainer(
    http,
    protocol,
    context,
    credentials.accessToken,
    operation.id,
  );
  if (!body) return { state: "not_found" };
  switch (body[protocol.statusField]) {
    case "IN_PROGRESS":
      return { providerOperationId: retainedOperationId, state: "processing" };
    case "FINISHED":
      if (operation.phase === "created") {
        return finalizeMetaContainer(http, protocol, context, credentials, operation.id);
      }
      return {
        result: unknownResult(`${protocol.provider}_publish_evidence_missing`, retainedOperationId),
        state: "unknown",
      };
    case "PUBLISHED":
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId:
            protocol.publishedOperationPhase === "submitted"
              ? containerOperationId("submitted", operation.id)
              : retainedOperationId,
        },
        state: "published",
      };
    case "ERROR":
      return {
        result: confirmedFailure(
          rejection(
            containerFailureCode(protocol.provider, body[protocol.failureDetailField]),
            422,
          ),
          retainedOperationId,
        ),
        state: "failed",
      };
    case "EXPIRED":
      return {
        result: confirmedFailure(
          rejection(`${protocol.provider}_container_expired`, 410),
          retainedOperationId,
        ),
        state: "failed",
      };
    default:
      throw malformed();
  }
}
