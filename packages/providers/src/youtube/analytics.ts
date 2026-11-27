import { requiredIdentifier, validateSnapshotPage } from "../failures";
import type {
  ProviderAccountAnalytics,
  ProviderAnalyticsRecord,
  ProviderCredentials,
  ProviderPage,
  ProviderPageInput,
  ProviderPublicationLookup,
  ProviderRequestContext,
} from "../types";
import { bearer } from "../values";
import { youtubeAccountStatistics, youtubeAnalyticsReport } from "./responses";
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
      return {
        ...youtubeAccountStatistics(response.body),
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
      const report = youtubeAnalyticsReport(response.body);
      if (!report) return { items: [] };
      return {
        items: [
          {
            ...report,
            impressions: 0,
            providerPostId,
            recordedAt: now().toISOString(),
            reach: 0,
            watchTimeSeconds: 0,
          },
        ],
      };
    },
  };
}
