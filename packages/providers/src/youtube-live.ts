import { malformed, unknownResult } from "./adapter-helpers";
import { ProviderAdapterError, classifyProviderFailure } from "./failures";
import type { ProviderHttpRequest, ProviderHttpResponse } from "./http";
import { bearer, boundedString, providerIdentifier, record, required } from "./meta-common";
import type {
  ProviderBroadcastInfo,
  ProviderCredentials,
  ProviderOperationResult,
  ProviderPublicationLookup,
  ProviderRequestContext,
  PublishInput,
} from "./types";

type GoogleRequest = <T>(
  context: ProviderRequestContext,
  request: Omit<ProviderHttpRequest, "classifyErrorBody">,
) => Promise<ProviderHttpResponse<T>>;
const origin = "https://www.googleapis.com";

/** Reads the broadcast identity without exposing stream/upload credentials in operation IDs. */
function broadcastId(lookup: ProviderPublicationLookup): string {
  const id = providerIdentifier(lookup.providerOperationId?.replace(/^live:/, ""));
  if (!lookup.providerOperationId?.startsWith("live:") || !id) throw malformed();
  return id;
}

/** Requires exactly the requested resource from a Google list response; never adopts another channel's row. */
function resource(value: unknown, id: string): Record<string, unknown> {
  const items = record(value)?.items;
  if (!Array.isArray(items) || items.length !== 1) throw malformed();
  const item = record(items[0]);
  if (!item || item.id !== id) throw malformed();
  return item;
}

/**
 * Implements the live-only protocol behind the existing YouTube adapter seam.
 * Broadcast creation precedes stream creation/binding so later uncertainty
 * retains a broadcast ID and can never initiate a duplicate public broadcast.
 * An external encoder supplies media; auto-start/stop follows actual ingest.
 */
export function youtubeLive(request: GoogleRequest, now: () => Date) {
  return {
    /**
     * Creates and binds an ingest resource; returns only a non-secret terminal
     * handoff. Google's required start time is one minute ahead to remain in the
     * future during request transit; actual start/stop follows encoder ingest.
     */
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
        !["public", "private", "unlisted"].includes(options.privacyStatus)
      ) {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "youtube_live_options_invalid", status: 400 }),
        );
      }
      const description = input.caption.trim();
      const title = required("title", description.split(/\r?\n/, 1)[0] ?? "", 100);
      const headers = { ...bearer(credentials.accessToken), "Content-Type": "application/json" };
      const created = await request<unknown>(context, {
        body: JSON.stringify({
          snippet: {
            title,
            description,
            scheduledStartTime: new Date(now().getTime() + 60_000).toISOString(),
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
        url: `${origin}/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails`,
      });
      const id = providerIdentifier(record(created.body)?.id);
      if (!id) throw malformed(true);
      try {
        const stream = await request<unknown>(context, {
          body: JSON.stringify({
            snippet: { title },
            cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
            contentDetails: { isReusable: false },
          }),
          headers,
          method: "POST",
          sideEffectPossible: true,
          url: `${origin}/youtube/v3/liveStreams?part=snippet,cdn,contentDetails`,
        });
        const streamId = providerIdentifier(record(stream.body)?.id);
        if (!streamId) throw malformed(true);
        const url = new URL(`${origin}/youtube/v3/liveBroadcasts/bind`);
        url.searchParams.set("id", id);
        url.searchParams.set("streamId", streamId);
        url.searchParams.set("part", "id,contentDetails");
        const bound = await request<unknown>(context, {
          headers,
          method: "POST",
          sideEffectPossible: true,
          url: url.toString(),
        });
        if (
          record(bound.body)?.id !== id ||
          record(record(bound.body)?.contentDetails)?.boundStreamId !== streamId
        )
          throw malformed(true);
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: `live:${id}`,
        };
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        // Broadcast already exists even when the stream/bind write failed. Reconcile, never re-create it.
        return unknownResult(cause.failure, `live:${id}`);
      }
    },
    /** Reads owner-scoped broadcast and stream metadata only on explicit, authorized demand. */
    async info(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderBroadcastInfo> {
      const id = broadcastId(lookup);
      const headers = bearer(credentials.accessToken);
      const response = await request<unknown>(context, {
        headers,
        method: "GET",
        url: `${origin}/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(id)}`,
      });
      const broadcast = resource(response.body, id);
      if (record(broadcast.snippet)?.channelId !== credentials.accountId) throw malformed();
      const lifecycle = record(broadcast.status)?.lifeCycleStatus;
      if (
        ![
          "created",
          "ready",
          "testing",
          "live",
          "complete",
          "revoked",
          "testStarting",
          "liveStarting",
        ].includes(String(lifecycle))
      )
        throw malformed();
      const state =
        lifecycle === "live"
          ? "live"
          : lifecycle === "testing"
            ? "testing"
            : lifecycle === "complete" || lifecycle === "revoked"
              ? "ended"
              : "ready";
      if (state === "ended")
        return {
          state,
          ...(lifecycle === "complete"
            ? { providerPostId: id, providerUrl: `https://youtu.be/${encodeURIComponent(id)}` }
            : {}),
        };
      const streamId = providerIdentifier(record(broadcast.contentDetails)?.boundStreamId);
      if (!streamId) throw malformed();
      const streamResponse = await request<unknown>(context, {
        headers,
        method: "GET",
        url: `${origin}/youtube/v3/liveStreams?part=cdn&id=${encodeURIComponent(streamId)}`,
      });
      const stream = resource(streamResponse.body, streamId);
      const ingest = record(record(stream.cdn)?.ingestionInfo);
      const ingestUrl = boundedString(ingest?.rtmpsIngestionAddress, 2048);
      const streamKey = boundedString(ingest?.streamName, 2048);
      if (
        !ingestUrl ||
        !URL.canParse(ingestUrl) ||
        new URL(ingestUrl).protocol !== "rtmps:" ||
        !streamKey
      )
        throw malformed();
      return {
        state,
        ingestUrl,
        streamKey,
        ...(state === "live" ? { providerPostId: id } : {}),
        providerUrl: `https://youtu.be/${encodeURIComponent(id)}`,
      };
    },
    /** Completes the known broadcast once; Google must confirm the same broadcast ID. */
    async end(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderOperationResult> {
      const id = broadcastId(lookup);
      const current = await request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: `${origin}/youtube/v3/liveBroadcasts?part=snippet,status&id=${encodeURIComponent(id)}`,
      });
      const broadcast = resource(current.body, id);
      if (record(broadcast.snippet)?.channelId !== credentials.accountId) throw malformed();
      const lifecycle = record(broadcast.status)?.lifeCycleStatus;
      if (
        ![
          "created",
          "ready",
          "testing",
          "live",
          "complete",
          "revoked",
          "testStarting",
          "liveStarting",
        ].includes(String(lifecycle))
      )
        throw malformed();
      if (lifecycle !== "live" && lifecycle !== "complete") {
        await request<unknown>(context, {
          headers: bearer(credentials.accessToken),
          method: "DELETE",
          sideEffectPossible: true,
          responseType: "empty",
          url: `${origin}/youtube/v3/liveBroadcasts?id=${encodeURIComponent(id)}`,
        });
        return {
          outcome: "confirmed_success",
          delivery: "broadcast",
          providerOperationId: `ended_live:${id}`,
        };
      }
      if (lifecycle === "complete")
        return {
          outcome: "confirmed_success",
          providerOperationId: `ended_live:${id}`,
          providerPostId: id,
          providerUrl: `https://youtu.be/${encodeURIComponent(id)}`,
        };
      const response = await request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: `${origin}/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(id)}&part=id,status`,
      });
      if (record(response.body)?.id !== id) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: `ended_live:${id}`,
        providerPostId: id,
        providerUrl: `https://youtu.be/${encodeURIComponent(id)}`,
      };
    },
  };
}
