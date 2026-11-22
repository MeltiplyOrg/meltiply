import { malformed, requiredIdentifier } from "../adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "../failures";
import type { ProviderHttpClient } from "../http";
import {
  bearer,
  metricValue,
  parseMetaInsightsMap,
  record,
  validatePageInput,
} from "../meta-common";
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
  FACEBOOK_API_VERSION,
  FACEBOOK_GRAPH_ORIGIN,
  facebookAccountId,
  parseFacebookOperationId,
  type FacebookOperationPhase,
} from "./types";

const nonReelAnalyticsPhases: ReadonlySet<FacebookOperationPhase> = new Set([
  "post",
  "post_draft",
  "video",
  "video_draft",
  "story",
  "live",
  "ended_live",
  "ab_test",
]);

/**
 * Builds the Facebook Page analytics methods (`getAccountAnalytics`, `listAnalytics`).
 */
export function createFacebookAnalytics(http: ProviderHttpClient, now: () => Date) {
  return {
    /** Reads Page followers only; Page likes (`fan_count`) are not accounts the Page follows. */
    async getAccountAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
    ): Promise<ProviderAccountAnalytics> {
      const url = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(facebookAccountId(credentials))}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      url.searchParams.set("fields", "followers_count");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const followers = metricValue(record(response.body)?.followers_count);
      if (followers === undefined) throw malformed();
      return {
        followers,
        recordedAt: now().toISOString(),
      };
    },

    /**
     * Reads lifetime engagement for one published Page Reel.
     * Video Insights supplies Reel plays and comments-plus-shares social actions;
     * the Video object supplies like and comment summaries. Any missing metric or
     * negative derived shares fails closed so no measurement is invented as zero.
     */
    async listAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
      page: ProviderPageInput,
    ): Promise<ProviderPage<ProviderAnalyticsRecord>> {
      const phase = parseFacebookOperationId(lookup.providerOperationId)?.phase;
      if (phase && nonReelAnalyticsPhases.has(phase)) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "facebook_format_analytics_unavailable",
            status: 422,
          }),
        );
      }
      validatePageInput("facebook", page);
      if (page.cursor) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "facebook_analytics_not_paginated",
            status: 400,
          }),
        );
      }
      const providerPostId = requiredIdentifier(
        lookup.providerPostId,
        "facebook_video_id_required",
      );
      const insightsUrl = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(providerPostId)}/video_insights`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      insightsUrl.searchParams.set("metric", "blue_reels_play_count,post_video_social_actions");
      insightsUrl.searchParams.set("period", "lifetime");
      const insightsResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: insightsUrl.toString(),
      });
      const metrics = parseMetaInsightsMap(insightsResponse.body, { strictSingleValue: true });

      const videoUrl = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(providerPostId)}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      videoUrl.searchParams.set(
        "fields",
        "likes.summary(true).limit(0),comments.summary(true).limit(0)",
      );
      const videoResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: videoUrl.toString(),
      });
      const video = record(videoResponse.body);
      const likes = metricValue(record(record(video?.likes)?.summary)?.total_count);
      const comments = metricValue(record(record(video?.comments)?.summary)?.total_count);
      const views = metrics.get("blue_reels_play_count");
      const socialActions = metrics.get("post_video_social_actions");
      if (
        comments === undefined ||
        likes === undefined ||
        views === undefined ||
        socialActions === undefined ||
        socialActions < comments
      ) {
        throw malformed();
      }
      return {
        items: [
          {
            comments,
            impressions: 0,
            likes,
            providerPostId,
            recordedAt: now().toISOString(),
            reach: 0,
            shares: socialActions - comments,
            views,
            watchTimeSeconds: 0,
          },
        ],
      };
    },
  };
}
