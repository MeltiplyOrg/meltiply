import { malformed, ProviderAdapterError, rejected } from "../failures";
import { unknownResult } from "../results";
import {
  YOUTUBE_PRIVACY_STATUSES,
  type ProviderBroadcastInfo,
  type ProviderCredentials,
  type ProviderOperationResult,
  type ProviderPublicationLookup,
  type ProviderRequestContext,
  type PublishInput,
} from "../types";
import {
  bearer,
  boundedString,
  firstNonEmptyLine,
  jsonHeaders,
  providerIdentifier,
  record,
  required,
  rtmpsUrl,
} from "../values";
import {
  broadcastOperationId,
  parseBroadcastOperationId,
  YOUTUBE_API_ORIGIN,
  YOUTUBE_LIMITS,
  youtubeWatchUrl,
  type GoogleRequest,
} from "./types";

const lifecycleStatuses = new Set([
  "created",
  "ready",
  "testing",
  "live",
  "complete",
  "revoked",
  "testStarting",
  "liveStarting",
]);
const maxIngestChars = 2048;
const scheduledStartLeadMilliseconds = 60_000;

function openBroadcastId(lookup: ProviderPublicationLookup): string {
  const operation = parseBroadcastOperationId(lookup.providerOperationId);
  if (operation?.phase !== "live") throw malformed();
  return operation.id;
}

function onlyResource(value: unknown, id: string): Record<string, unknown> {
  const items = record(value)?.items;
  if (!Array.isArray(items) || items.length !== 1) throw malformed();
  const item = record(items[0]);
  if (!item || item.id !== id) throw malformed();
  return item;
}

function endedBroadcast(id: string): ProviderOperationResult {
  return {
    outcome: "confirmed_success",
    providerOperationId: broadcastOperationId({ id, phase: "ended_live" }),
    providerPostId: id,
    providerUrl: youtubeWatchUrl(id),
  };
}

/**
 * Live broadcasts use an external encoder. The broadcast is created before its
 * stream and binding, so later uncertainty retains the broadcast ID and never
 * creates a duplicate public broadcast.
 */
export function createYouTubeLive(request: GoogleRequest, now: () => Date) {
  const readBroadcast = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    id: string,
    parts: string,
  ): Promise<{ broadcast: Record<string, unknown>; lifecycle: string }> => {
    const response = await request(context, {
      headers: bearer(credentials.accessToken),
      method: "GET",
      url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveBroadcasts?part=${parts}&id=${encodeURIComponent(id)}`,
    });
    const broadcast = onlyResource(response.body, id);
    if (record(broadcast.snippet)?.channelId !== credentials.accountId) throw malformed();
    const lifecycle = record(broadcast.status)?.lifeCycleStatus;
    if (typeof lifecycle !== "string" || !lifecycleStatuses.has(lifecycle)) throw malformed();
    return { broadcast, lifecycle };
  };

  return {
    async publish(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      input: PublishInput,
    ): Promise<ProviderOperationResult> {
      const options = input.providerOptions?.youtube;
      if (
        input.media.length ||
        typeof options?.madeForKids !== "boolean" ||
        !options.privacyStatus ||
        !YOUTUBE_PRIVACY_STATUSES.has(options.privacyStatus)
      ) {
        throw rejected("youtube_live_options_invalid");
      }
      const description = input.caption.trim();
      const title = required(
        "title",
        firstNonEmptyLine(description) ?? "",
        YOUTUBE_LIMITS.maxTitleCodePoints,
      );
      const headers = jsonHeaders(credentials.accessToken);
      const created = await request(context, {
        body: JSON.stringify({
          snippet: {
            title,
            description,
            scheduledStartTime: new Date(
              now().getTime() + scheduledStartLeadMilliseconds,
            ).toISOString(),
          },
          status: {
            privacyStatus: options.privacyStatus,
            selfDeclaredMadeForKids: options.madeForKids,
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: true,
            monitorStream: { enableMonitorStream: false },
          },
        }),
        headers,
        method: "POST",
        sideEffectPossible: true,
        url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails`,
      });
      const id = providerIdentifier(record(created.body)?.id);
      if (!id) throw malformed(true);
      const operationId = broadcastOperationId({ id, phase: "live" });
      try {
        const stream = await request(context, {
          body: JSON.stringify({
            snippet: { title },
            cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
            contentDetails: { isReusable: false },
          }),
          headers,
          method: "POST",
          sideEffectPossible: true,
          url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveStreams?part=snippet,cdn,contentDetails`,
        });
        const streamId = providerIdentifier(record(stream.body)?.id);
        if (!streamId) throw malformed(true);
        const bindUrl = new URL(`${YOUTUBE_API_ORIGIN}/youtube/v3/liveBroadcasts/bind`);
        bindUrl.searchParams.set("id", id);
        bindUrl.searchParams.set("streamId", streamId);
        bindUrl.searchParams.set("part", "id,contentDetails");
        const bound = record(
          (
            await request(context, {
              headers,
              method: "POST",
              sideEffectPossible: true,
              url: bindUrl.toString(),
            })
          ).body,
        );
        if (bound?.id !== id || record(bound.contentDetails)?.boundStreamId !== streamId) {
          throw malformed(true);
        }
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: operationId,
        };
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        return unknownResult(cause.failure.code, operationId);
      }
    },

    async info(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderBroadcastInfo> {
      const id = openBroadcastId(lookup);
      const { broadcast, lifecycle } = await readBroadcast(
        context,
        credentials,
        id,
        "snippet,status,contentDetails",
      );
      if (lifecycle === "complete") {
        return { state: "ended", providerPostId: id, providerUrl: youtubeWatchUrl(id) };
      }
      if (lifecycle === "revoked") return { state: "ended" };
      const streamId = providerIdentifier(record(broadcast.contentDetails)?.boundStreamId);
      if (!streamId) throw malformed();
      const streamResponse = await request(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveStreams?part=cdn&id=${encodeURIComponent(streamId)}`,
      });
      const ingest = record(record(onlyResource(streamResponse.body, streamId).cdn)?.ingestionInfo);
      const ingestUrl = rtmpsUrl(ingest?.rtmpsIngestionAddress, maxIngestChars);
      const streamKey = boundedString(ingest?.streamName, maxIngestChars);
      if (!ingestUrl || !streamKey) {
        throw malformed();
      }
      const state = lifecycle === "live" ? "live" : lifecycle === "testing" ? "testing" : "ready";
      return {
        state,
        ingestUrl,
        streamKey,
        ...(state === "live" ? { providerPostId: id } : {}),
        providerUrl: youtubeWatchUrl(id),
      };
    },

    async end(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderOperationResult> {
      const id = openBroadcastId(lookup);
      const { lifecycle } = await readBroadcast(context, credentials, id, "snippet,status");
      if (lifecycle === "complete") return endedBroadcast(id);
      if (lifecycle !== "live") {
        await request(context, {
          headers: bearer(credentials.accessToken),
          method: "DELETE",
          sideEffectPossible: true,
          responseType: "empty",
          url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveBroadcasts?id=${encodeURIComponent(id)}`,
        });
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: broadcastOperationId({ id, phase: "ended_live" }),
        };
      }
      const response = await request(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: `${YOUTUBE_API_ORIGIN}/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(id)}&part=id,status`,
      });
      if (record(response.body)?.id !== id) throw malformed(true);
      return endedBroadcast(id);
    },
  };
}
