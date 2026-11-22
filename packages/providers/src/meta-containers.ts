import type { components } from "@meltiply/contracts";

import { confirmedFailure, isHttp404, malformed, unknownResult } from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import type { ProviderHttpClient } from "./http";
import {
  bearer,
  containerOperationId,
  metaContainerFailureCode,
  providerIdentifier,
  record,
  type MetaContainerOperation,
} from "./meta-common";
import type {
  ProviderCredentials,
  ProviderPublicationStatus,
  ProviderRequestContext,
} from "./types";

type ProviderWarnings = components["schemas"]["Distribution"]["provider_warnings"];

/**
 * Per-platform protocol parameters for Meta's container-create / poll / publish
 * state machine shared by Instagram and Threads.
 */
export interface MetaContainerProtocolConfig {
  /** Base Graph API origin (e.g. `https://graph.instagram.com` or `https://graph.threads.com`). */
  apiOrigin: string;
  /** Builds the container read URL for `containerId` including its required fields query. */
  containerReadUrl: (containerId: string) => string;
  /** Extracts sanitized partial-publish warnings from a confirmed publish response body. */
  extractWarnings?: (body: Record<string, unknown>) => ProviderWarnings | undefined;
  /** Field name carrying provider failure detail on ERROR containers (`status` vs `error_message`). */
  failureDetailField: "status" | "error_message";
  /** Provider prefix used for failure codes (`instagram` or `threads`). */
  provider: "instagram" | "threads";
  /** Builds the finalizing publish POST URL for `containerId`. */
  publishUrl: (credentials: ProviderCredentials, containerId: string) => string;
  /**
   * Operation ID phase reported when a container already reports `PUBLISHED`.
   * Instagram normalizes to `submitted:<id>`; Threads retains the caller's phase.
   */
  publishedOperationPhase: "retain" | "submitted";
  /** Field name carrying the container lifecycle state (`status_code` vs `status`). */
  statusField: "status_code" | "status";
}

/**
 * Reads a Meta media container's status node without side effects.
 * Returns the validated response record (matching `containerId`), or undefined
 * on HTTP 404. Throws `ProviderAdapterError` on transport failure or shape mismatch.
 */
export async function readMetaContainer(
  http: ProviderHttpClient,
  config: MetaContainerProtocolConfig,
  context: ProviderRequestContext,
  accessToken: string,
  containerId: string,
): Promise<Record<string, unknown> | undefined> {
  let response;
  try {
    response = await http.request<unknown>(context, {
      headers: bearer(accessToken),
      method: "GET",
      url: config.containerReadUrl(containerId),
    });
  } catch (cause) {
    if (isHttp404(cause)) return undefined;
    throw cause;
  }
  const body = record(response.body);
  if (providerIdentifier(body?.id) !== containerId) throw malformed();
  return body;
}

/**
 * Issues the single finalizing publish for a ready Meta media container.
 * Success and non-retryable rejections retain `created:<id>`; an ambiguous
 * outcome records `submitted:<id>` so reconciliation never dispatches a second
 * publish; a retryable rejection keeps the container `processing` so the next
 * poll retries finalization.
 */
async function finalizeMetaContainer(
  http: ProviderHttpClient,
  config: MetaContainerProtocolConfig,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  containerId: string,
): Promise<ProviderPublicationStatus> {
  const createdOperationId = containerOperationId("created", containerId);
  try {
    const response = await http.request<unknown>(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      sideEffectPossible: true,
      url: config.publishUrl(credentials, containerId),
    });
    const body = record(response.body);
    const providerPostId = providerIdentifier(body?.id);
    if (!body || !providerPostId) throw malformed(true);
    const warnings = config.extractWarnings?.(body);
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
        result: unknownResult(cause.failure, containerOperationId("submitted", containerId)),
        state: "unknown",
      };
    }
    if (cause.failure.retryable) {
      return { providerOperationId: createdOperationId, state: "processing" };
    }
    return {
      result: confirmedFailure(cause.failure, createdOperationId),
      state: "failed",
    };
  }
}

/**
 * Reconciles a persisted Meta container operation into a `ProviderPublicationStatus`.
 * A `created` container reporting `FINISHED` is finalized exactly once through
 * `finalizeMetaContainer`; a `submitted` container is never republished.
 * Container `ERROR` detail is normalized to a safe diagnostic category code.
 */
export async function lookupMetaContainer(
  http: ProviderHttpClient,
  config: MetaContainerProtocolConfig,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  operation: MetaContainerOperation,
): Promise<ProviderPublicationStatus> {
  const retainedOperationId = containerOperationId(operation.phase, operation.id);
  const body = await readMetaContainer(
    http,
    config,
    context,
    credentials.accessToken,
    operation.id,
  );
  if (!body) return { state: "not_found" };
  switch (body[config.statusField]) {
    case "IN_PROGRESS":
      return {
        providerOperationId: retainedOperationId,
        state: "processing",
      };
    case "FINISHED":
      if (operation.phase === "created") {
        return finalizeMetaContainer(http, config, context, credentials, operation.id);
      }
      return {
        result: unknownResult(
          classifyProviderFailure({
            code: `${config.provider}_publish_evidence_missing`,
            sideEffectPossible: true,
          }),
          retainedOperationId,
        ),
        state: "unknown",
      };
    case "PUBLISHED":
      return {
        result: {
          outcome: "confirmed_success",
          providerOperationId:
            config.publishedOperationPhase === "submitted"
              ? containerOperationId("submitted", operation.id)
              : retainedOperationId,
        },
        state: "published",
      };
    case "ERROR":
      return {
        result: confirmedFailure(
          metaContainerFailureCode(config.provider, body[config.failureDetailField]),
          422,
          retainedOperationId,
        ),
        state: "failed",
      };
    case "EXPIRED":
      return {
        result: confirmedFailure(`${config.provider}_container_expired`, 410, retainedOperationId),
        state: "failed",
      };
    default:
      throw malformed();
  }
}
