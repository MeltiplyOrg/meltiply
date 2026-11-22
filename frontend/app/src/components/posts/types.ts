import type { ChannelIntegration, PostContentItem } from "@/api/types";
import type { WorkspaceView } from "@/lib/navigation";
import type {
  Asset,
  BrandProfile,
  CalendarEvent,
  Distribution,
  Post,
  PostAttachment,
  PostTarget,
} from "@/types";

export type { BrandProfile };

export interface ChannelMediaItem {
  assetId: string;
  assetType: Asset["asset_type"];
  attachment?: PostAttachment;
  position: number;
  contentType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface PostDetailItem {
  id: string;
  postId: string;
  publishDate: string;
  status: string;
  errorMessage?: string | null;
  integration?: ChannelIntegration;
  content: PostContentItem[];
  attachments: ChannelMediaItem[];
  distribution?: Distribution;
  target?: PostTarget;
  calendarEvent?: CalendarEvent;
}

export interface PostRow {
  id: string;
  date: string;
  status: string;
  channels: PostDetailItem[];
  brandProfileId: string;
  post?: Post;
}

export type PostViewMode = "table" | "calendar" | "grid";

export type PostStatusFilter = "all" | "scheduled" | "published" | "draft" | "failed";

export type PostSortKey = "date-desc" | "date-asc";

export interface FilterCriteria {
  statusFilter: readonly Exclude<PostStatusFilter, "all">[];
  platformFilter: readonly string[];
  profileFilter: readonly string[];
  searchQuery: string;
  dateFilter: string;
  sortKey: PostSortKey;
}

export interface CalendarDayCell {
  date: Date;
  isCurrentMonth: boolean;
  dayNumber: number;
}

export interface PostSelectionProps {
  selectedIds: ReadonlySet<string>;
  onToggleSelection: (postId: string) => void;
  onSetSelection: (postIds: string[], selected: boolean) => void;
  selectionDisabled?: boolean;
  canSelect?: (post: PostRow) => boolean;
}

export interface PostSelectionEntry {
  id: string;
  brandProfileId: string;
  isDraft: boolean;
}

export interface PostDestructiveRequest {
  kind: "delete-post" | "cancel-channels";
  postId: string;
  brandProfileId: string;
  distributionIds: string[];
}

export interface PostsViewProps {
  initialViewMode?: PostViewMode;
  initialStatusFilter?: PostStatusFilter;
  initialPostId?: string;
  initialComposerOpen?: boolean;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

export const SKELETON_TABLE_KEYS = Array.from({ length: 18 }, (_, index) => `row-sk-${index + 1}`);
export const SKELETON_CARD_KEYS = Array.from({ length: 8 }, (_, index) => `card-sk-${index + 1}`);
