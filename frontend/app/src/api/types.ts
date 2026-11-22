export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  orgId: string;
  role?: string;
  isInstallationOwner?: boolean;
}
export interface ChannelIntegration {
  id: string;
  platformUserId: string;
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
