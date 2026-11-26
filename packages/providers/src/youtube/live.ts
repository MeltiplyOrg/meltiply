import { malformed, ProviderAdapterError } from "../failures";
import { unknownResult } from "../results";
import type {
  ProviderBroadcastInfo,
  ProviderCredentials,
  ProviderOperationResult,
  ProviderPublicationLookup,
  ProviderRequestContext,
  PublishInput,
} from "../types";
import { bearer, jsonHeaders, providerIdentifier, record } from "../values";
import { youtubeBroadcastRecord, youtubeLivePlan, youtubeStreamIngest } from "./responses";
import {
  broadcastOperationId,
  parseBroadcastOperationId,
  YOUTUBE_API_ORIGIN,
  youtubeWatchUrl,
  type GoogleRequest,
} from "./types";

const scheduledStartLeadMilliseconds = 60_000;

function openBroadcastId(lookup: ProviderPublicationLookup): string {
  const operation = parseBroadcastOperationId(lookup.providerOperationId);
  if (operation?.phase !== "live") throw malformed();
  return operation.id;
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
    return youtubeBroadcastRecord(response.body, id, credentials.accountId);
  };

  return {
    async publish(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      input: PublishInput,
    ): Promise<ProviderOperationResult> {
      const { description, madeForKids, privacyStatus, title } = youtubeLivePlan(input);
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
            privacyStatus,
            selfDeclaredMadeForKids: madeForKids,
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
      const { ingestUrl, streamKey } = youtubeStreamIngest(streamResponse.body, streamId);
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
