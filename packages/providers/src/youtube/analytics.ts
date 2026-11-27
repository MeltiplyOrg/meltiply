import { malformed, requiredIdentifier, validateSnapshotPage } from "../failures";
import { engagementSnapshot } from "../results";
import type {
  ProviderAccountAnalytics,
  ProviderAnalyticsRecord,
  ProviderCredentials,
  ProviderPage,
  ProviderPageInput,
  ProviderPublicationLookup,
  ProviderRequestContext,
} from "../types";
import {
  bearer,
  boundedString,
  metricValue,
  nonNegativeIntegerStringOrNumber,
  record,
} from "../values";
import {
  YOUTUBE_ANALYTICS_ORIGIN,
  YOUTUBE_API_ORIGIN,
  youtubeAccountId,
  type GoogleRequest,
} from "./types";

export function createYouTubeAnalytics(googleRequest: GoogleRequest, now: () => Date) {
  return {
    async getAccountAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
    ): Promise<ProviderAccountAnalytics> {
      const url = new URL("/youtube/v3/channels", YOUTUBE_API_ORIGIN);
      url.searchParams.set("part", "statistics");
      url.searchParams.set("mine", "true");
      const response = await googleRequest(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const items = record(response.body)?.items;
      if (!Array.isArray(items) || items.length !== 1) throw malformed();
      const statistics = record(record(items[0])?.statistics);
      if (statistics?.hiddenSubscriberCount === true) throw malformed();
      const followers = nonNegativeIntegerStringOrNumber(statistics?.subscriberCount);
      const posts = nonNegativeIntegerStringOrNumber(statistics?.videoCount);
      if (followers === undefined) throw malformed();
      return {
        followers,
        ...(posts !== undefined ? { posts } : {}),
        recordedAt: now().toISOString(),
      };
    },

    async listAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
      page: ProviderPageInput,
    ): Promise<ProviderPage<ProviderAnalyticsRecord>> {
      validateSnapshotPage("youtube", page);
      const providerPostId = requiredIdentifier(lookup.providerPostId, "youtube_video_id_required");
      const channelId = youtubeAccountId(credentials);
      const url = new URL("/v2/reports", YOUTUBE_ANALYTICS_ORIGIN);
      url.searchParams.set("ids", `channel==${channelId}`);
      url.searchParams.set("startDate", "2005-02-14");
      url.searchParams.set("endDate", now().toISOString().slice(0, 10));
      url.searchParams.set("metrics", "views,likes,comments,shares");
      url.searchParams.set("filters", `video==${providerPostId}`);
      const response = await googleRequest(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      const columnHeaders = body?.columnHeaders;
      if (!Array.isArray(columnHeaders)) throw malformed();
      const rows = body?.rows;
      if (rows === undefined) return { items: [] };
      if (!Array.isArray(rows)) throw malformed();
      if (rows.length === 0) return { items: [] };
      const row = rows[0];
      if (rows.length !== 1 || !Array.isArray(row) || row.length !== columnHeaders.length) {
        throw malformed();
      }
      const metrics = new Map<string, number>();
      for (const [index, value] of columnHeaders.entries()) {
        const name = boundedString(record(value)?.name, 64);
        const metric = metricValue(row[index]);
        if (!name || metric === undefined || metrics.has(name)) throw malformed();
        metrics.set(name, metric);
      }
      const views = metrics.get("views");
      const likes = metrics.get("likes");
      const comments = metrics.get("comments");
      const shares = metrics.get("shares");
      if (
        views === undefined ||
        likes === undefined ||
        comments === undefined ||
        shares === undefined
      ) {
        throw malformed();
      }
      return engagementSnapshot({ comments, likes, providerPostId, shares, views }, now());
    },
  };
}
