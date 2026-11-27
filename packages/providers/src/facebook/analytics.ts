import { rejected, requiredIdentifier, validateSnapshotPage } from "../failures";
import type { ProviderHttpClient } from "../http";
import { parseMetaInsightsMap } from "../meta";
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
import { facebookAccountFollowers, facebookReelEngagement } from "./responses";
import {
  facebookAccountId,
  graphGet,
  graphUrl,
  nodeUrl,
  parseFacebookOperationId,
  type FacebookOperationPhase,
} from "./types";

const nonReelPhases: ReadonlySet<FacebookOperationPhase> = new Set([
  "post",
  "post_draft",
  "video",
  "video_draft",
  "story",
  "live",
  "ended_live",
  "ab_test",
]);

export function createFacebookAnalytics(http: ProviderHttpClient, now: () => Date) {
  return {
    async getAccountAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
    ): Promise<ProviderAccountAnalytics> {
      const body = await graphGet(
        http,
        context,
        credentials.accessToken,
        nodeUrl(facebookAccountId(credentials), "followers_count"),
      );
      return { followers: facebookAccountFollowers(body), recordedAt: now().toISOString() };
    },

    async listAnalytics(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
      page: ProviderPageInput,
    ): Promise<ProviderPage<ProviderAnalyticsRecord>> {
      const phase = parseFacebookOperationId(lookup.providerOperationId)?.phase;
      if (phase && nonReelPhases.has(phase)) {
        throw rejected("facebook_format_analytics_unavailable", 422);
      }
      validateSnapshotPage("facebook", page);
      const providerPostId = requiredIdentifier(
        lookup.providerPostId,
        "facebook_video_id_required",
      );
      const insightsUrl = graphUrl(`${encodeURIComponent(providerPostId)}/video_insights`);
      insightsUrl.searchParams.set("metric", "blue_reels_play_count,post_video_social_actions");
      insightsUrl.searchParams.set("period", "lifetime");
      const metrics = parseMetaInsightsMap(
        await graphGet(http, context, credentials.accessToken, insightsUrl),
        { singleValue: true },
      );
      const video = await graphGet(
        http,
        context,
        credentials.accessToken,
        nodeUrl(providerPostId, "likes.summary(true).limit(0),comments.summary(true).limit(0)"),
      );
      return engagementSnapshot(
        { ...facebookReelEngagement(metrics, video), providerPostId },
        now(),
      );
    },
  };
}
