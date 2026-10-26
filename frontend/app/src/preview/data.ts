import type {
  Asset,
  BrandProfile,
  Distribution,
  PlatformAccount,
  PlatformCapability,
  Post,
  UserProfile,
  AnalyticsDashboard,
} from "@/types";
import sampleUrl from "./sample.svg?url";

const workspaceId = "00000000-0000-4000-8000-000000000001";
export const userId = "00000000-0000-4000-8000-000000000011";
export const profileId = "00000000-0000-4000-8000-000000000111";
const now = new Date();
export const timestamp = now.toISOString();

export const user: UserProfile = {
  id: userId,
  email: "preview@example.test",
  display_name: "Preview Creator",
  avatar_url: null,
  active_organization: {
    id: workspaceId,
    name: "UI Preview Workspace",
    slug: "ui-preview",
    role: "admin",
  },
  is_installation_owner: true,
  created_at: timestamp,
  updated_at: timestamp,
};
export const profiles: BrandProfile[] = [
  {
    id: profileId,
    org_id: workspaceId,
    name: "Studio",
    description: "Synthetic editorial content",
    color: "#4338ca",
    deleted_at: null,
    purge_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  },
  {
    id: "00000000-0000-4000-8000-000000000112",
    org_id: workspaceId,
    name: "Community",
    description: "Sample community updates",
    color: "#0f766e",
    deleted_at: null,
    purge_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  },
];
export const capabilities: PlatformCapability[] = (
  ["threads", "instagram", "tiktok", "youtube", "facebook"] as const
).map((platform) => ({
  platform,
  connect_available: false,
  asset_types: ["image", "video"],
  publish: true,
  analytics: true,
  comments: false,
  reply: false,
  max_caption_length: 2200,
  max_hashtags: 30,
  max_media_count: 10,
  min_media_count: platform === "threads" ? 0 : 1,
  multi_asset_types: ["image"],
  max_file_size: 524288000,
  max_video_duration_sec: 600,
  accepted_mime_types: ["image/jpeg", "image/png", "video/mp4"],
  notes: ["Synthetic UI preview; no external publishing."],
}));
export const accounts: PlatformAccount[] = capabilities.slice(0, 3).map((capability, index) => ({
  id: `00000000-0000-4000-8000-00000000020${index + 1}`,
  org_id: workspaceId,
  brand_profile_id: profileId,
  platform: capability.platform,
  platform_user_id: `preview-${capability.platform}`,
  display_name: `Studio on ${capability.platform}`,
  username: "preview.studio",
  avatar_url: null,
  connection_status: index === 2 ? "reconnect_required" : "connected",
  token_expires_at: null,
  rate_limit_budget: null,
  last_synced_at: timestamp,
  scopes: [],
  capabilities: capability,
  created_at: timestamp,
  updated_at: timestamp,
}));
export const asset: Asset = {
  id: "00000000-0000-4000-8000-000000000101",
  org_id: workspaceId,
  brand_profile_id: profileId,
  uploaded_by: userId,
  asset_type: "image",
  title: "Sample artwork",
  status: "ready",
  file_size: 1024,
  mime_type: "image/svg+xml",
  width: 640,
  height: 640,
  duration_sec: null,
  thumbnail_url: sampleUrl,
  download_url: sampleUrl,
  failure: null,
  created_at: timestamp,
  updated_at: timestamp,
};

/** Builds frozen synthetic Channel outcomes for calendar and inspector review; no Provider action is performed. */
function sampleDistribution(index: number): Distribution {
  const status = index === 1 ? "published" : index === 2 ? "scheduled" : "failed";
  return {
    id: `00000000-0000-4000-8000-00000000030${index}`,
    org_id: workspaceId,
    brand_profile_id: profileId,
    post_id: `00000000-0000-4000-8000-00000000070${index + 1}`,
    platform_account_id: accounts[0]!.id,
    platform: "threads",
    status,
    scheduled_at: new Date(now.getTime() + (index === 2 ? 86400000 : -86400000)).toISOString(),
    published_at: status === "published" ? timestamp : null,
    platform_post_id: null,
    platform_url: null,
    publication: null,
    title_override: null,
    description_override: null,
    hashtags: [],
    attempt_count: status === "scheduled" ? 0 : 1,
    last_attempt_at: null,
    next_attempt_at: null,
    failure:
      status === "failed"
        ? {
            code: "preview_sample_failure",
            message: "Synthetic publishing failure for UI review.",
            retryable: false,
            last_occurred_at: timestamp,
          }
        : null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Creates fresh synthetic Posts for each browser load; dates stay near today so calendars remain useful. */
export function createPosts(): Post[] {
  return [
    "A little progress, every day",
    "Behind the scenes at the studio",
    "Next week's community update",
    "Ideas worth sharing",
  ].map((title, index) => ({
    id: `00000000-0000-4000-8000-00000000070${index + 1}`,
    org_id: workspaceId,
    brand_profile_id: profileId,
    title,
    default_text: `${title}. This is synthetic sample content for reviewing the interface.`,
    status: index === 0 ? "draft" : "active",
    revision: 1,
    attachments: index === 1 ? [] : [{ asset_id: asset.id, position: 0, asset }],
    targets: [
      {
        platform_account_id: accounts[0]!.id,
        title_override: null,
        description_override: null,
        hashtags: [],
        provider_options: null,
        attachment_ids: null,
      },
    ],
    distributions: index === 0 ? [] : [sampleDistribution(index)],
    analytics:
      index === 1
        ? {
            likes: 84,
            comments: 12,
            shares: 9,
            views: 1200,
            impressions: 1500,
            reach: 980,
            saves: null,
            clicks: null,
          }
        : null,
    distribution_analytics: [],
    queue_membership: null,
    created_at: new Date(now.getTime() - index * 86400000).toISOString(),
    updated_at: timestamp,
  }));
}

/** Produces a coherent synthetic analytics cohort inside the requested interval, without querying a Provider. */
export function analytics(start: string, end: string): AnalyticsDashboard {
  const totals = {
    views: 1200,
    likes: 84,
    comments: 12,
    shares: 9,
    watch_time_sec: 0,
    reach: 980,
    impressions: 1500,
    post_count: 3,
  };
  return {
    range: { start, end },
    series: [
      {
        date: start.slice(0, 10),
        platform: "threads",
        posts: 3,
        views: 1200,
        likes: 84,
        comments: 12,
        shares: 9,
        impressions: 1500,
        reach: 980,
        last_synced_at: timestamp,
      },
    ],
    best_times: [
      {
        day_of_week: 1,
        hour: 14,
        posts: 3,
        avg_views: 400,
        avg_likes: 28,
        avg_comments: 4,
        avg_shares: 3,
        avg_engagement: 35,
      },
    ],
    formats: [
      {
        format: "image",
        posts: 3,
        views: 1200,
        likes: 84,
        comments: 12,
        shares: 9,
        engagement: 105,
        avg_views: 400,
        avg_engagement: 35,
        last_synced_at: timestamp,
      },
    ],
    platforms: [
      {
        platform: "threads",
        posts: 3,
        views: 1200,
        likes: 84,
        comments: 12,
        shares: 9,
        impressions: 1500,
        reach: 980,
        engagement_rate: 0.0875,
        followers: 500,
        follower_gain: 20,
        saves: null,
        clicks: null,
        last_synced_at: timestamp,
      },
    ],
    cohort: {
      range: { start, end },
      totals,
      by_platform: [{ platform: "threads", ...totals, last_synced_at: timestamp }],
      last_synced_at: timestamp,
      partial: false,
      unsupported_platforms: [],
    },
    followers: [
      {
        platform: "threads",
        account_id: accounts[0]!.id,
        account_name: "Studio",
        points: [
          { captured_at: start, followers: 480 },
          { captured_at: end, followers: 500 },
        ],
      },
    ],
    accumulation: [{ elapsed_hours: 1, avg_engagement: 35, observations: 3 }],
    unavailable_metrics: ["saves", "clicks"],
  };
}
