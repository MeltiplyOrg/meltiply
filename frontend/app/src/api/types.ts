export interface UserProfile {
  id: string;
  email: string;
  name: string;
  /** Account-provided avatar URL; missing or failed images use the user-icon fallback. */
  avatarUrl?: string | null;
  orgId: string;
  role?: string;
  /** True when this account owns the installation. */
  isInstallationOwner?: boolean;
}
/**
 * Source-shaped channel row consumed by the frontend views. `brandProfileId`
 * is the required owning Brand Profile UUID from the contract PlatformAccount.
 */
export interface ChannelIntegration {
  id: string;
  /** Provider account ID displayed in channel identity rows, distinct from the internal id. */
  platformUserId: string;
  /** Real provider username, separate from the provider ID and display name; may be absent. */
  username?: string | null;
  name: string;
  picture?: string | null;
  providerIdentifier: string;
  type: string;
  disabled: boolean;
  refreshNeeded: boolean;
  brandProfileId: string;
  postingTimes?: string;
  additionalSettings?: string;
}

/**
 * Source-shaped media reference for composer and Posts preview projections.
 * `id` is the durable Asset identifier; `path` is the displayable preview URL
 * or label the surface renders, and `name` is the creator-visible file name.
 * It carries no lifecycle state — readiness and processing come from the
 * Post's embedded attachment Asset, never from this projection.
 */
export interface MediaItem {
  id: string;
  path: string;
  name?: string;
}

export interface PostContentItem {
  id?: string;
  content: string;
  image?: MediaItem[];
  delay?: number;
}

export interface YoutubeSettings {
  title: string;
  type: "public" | "private" | "unlisted";
  selfDeclaredMadeForKids?: "no" | "yes";
  tags?: Array<{ value: string; label: string }>;
  thumbnail?: MediaItem;
}

export interface TikTokSettings {
  title?: string;
  privacy_level:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY";
  duet: boolean;
  stitch: boolean;
  comment: boolean;
}
