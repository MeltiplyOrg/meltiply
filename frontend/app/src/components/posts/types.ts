import type { ChannelIntegration, PostContentItem } from "@/api/types";
import type { WorkspaceView } from "@/components/layout/navigation-shell";
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

/**
 * One ordered media slot a Channel publishes — the view-model projection of a
 * live {@link PostAttachment} or of a frozen `DistributionPublicationMedia`
 * entry. Once a Provider attempt claimed the Channel's outcome its frozen
 * `publication.media` supplies the slots, so a frozen Asset detached from the
 * Post keeps its identity and descriptive facts with `attachment` undefined.
 */
export interface ChannelMediaItem {
  /** UUID of the Asset occupying this slot. */
  assetId: string;
  /** Contract `AssetType` of the delivered or pending media. */
  assetType: Asset["asset_type"];
  /** Live Post attachment for this slot; absent once the Asset was detached. */
  attachment?: PostAttachment;
  /** Order index within the Channel's media list. */
  position: number;
  /** Frozen MIME type recorded at claim time, when one exists. */
  contentType?: string | null;
  /** Frozen byte size recorded at claim time, when one exists. */
  fileSize?: number | null;
  /** Frozen pixel width recorded at claim time, when one exists. */
  width?: number | null;
  /** Frozen pixel height recorded at claim time, when one exists. */
  height?: number | null;
  /** Frozen media duration in seconds recorded at claim time, when one exists. */
  durationSec?: number | null;
}

/**
 * Per-channel entry inside one Post row — the view-model projection of a saved
 * per-Channel {@link PostTarget} and its independent {@link Distribution}
 * outcome, or of a calendar event whose Post page did not cover its range.
 *
 * Field mapping from the contract: `id` is `distribution.id` when an outcome
 * exists, otherwise a synthetic `target:<platform_account_id>` key; `postId` is
 * the stable `Post.id` every entry of a row shares; `content[0].content` is the
 * frozen `publication` caption for a claimed Channel, else `title_override` →
 * `description_override` → the Post's `default_text`; `attachments` is the
 * ordered media resolved for this Channel — the frozen `publication.media` for
 * a claimed Channel, else the target's `attachment_ids` override or the Post's
 * own order; `publishDate` is `scheduled_at ?? published_at ?? created_at` for
 * an outcome; `status` is the contract `DistributionStatus`, or `'draft'` for a
 * saved target that has no outcome yet; `errorMessage` is
 * `distribution.failure.message`.
 */
export interface PostDetailItem {
  /** Stable key within the row: the Distribution id, or `target:<account uuid>`. */
  id: string;
  /** Stable `Post.id` identity shared by every channel entry of the row. */
  postId: string;
  /** ISO timestamp used for display and day bucketing. */
  publishDate: string;
  /** Contract `DistributionStatus`, or the Post's `'draft'` state for a pending target. */
  status: string;
  /** Failure message from `distribution.failure.message`, when present. */
  errorMessage?: string | null;
  /** Workspace channel integration targeted by this outcome, if still connected. */
  integration?: ChannelIntegration;
  /** Resolved content and preview images for this Channel. */
  content: PostContentItem[];
  /** Ordered media this Channel publishes, in publication order. */
  attachments: ChannelMediaItem[];
  /** Independent outcome backing this entry; absent for a saved target with no outcome. */
  distribution?: Distribution;
  /** Saved per-Channel settings this entry was built from, when the Post carries one. */
  target?: PostTarget;
  /** Backing calendar event when the row was produced by `useCalendar`. */
  calendarEvent?: CalendarEvent;
}

/**
 * One durable Post rendered as a single row in the list, grid, calendar, and
 * detail surfaces. Rows are keyed by `Post.id`, so differing per-channel
 * publication times and content overrides never split one composition, while
 * two identically composed but separately created Posts stay distinct rows.
 */
export interface PostRow {
  /** Stable `Post.id` — the single identity across every Posts surface. */
  id: string;
  /** ISO display instant for the row; see `resolvePostDisplayDate`. */
  date: string;
  /**
   * Aggregate display status derived only from Channel outcomes (see
   * `summarizeChannelStatuses`), or the Post's own `'draft'` state. Never
   * derived from `Post.status` as a global success flag.
   */
  status: string;
  /** One entry per Channel: saved targets and their independent outcomes. */
  channels: PostDetailItem[];
  /** Owning Brand Profile UUID — authorizes deletion independently of the active scope selection. */
  brandProfileId: string;
  /**
   * Durable Post behind the row. Absent only for a calendar event whose Post
   * falls outside the loaded Post page, where the row degrades to the event's
   * own channel outcome instead of inventing Post content.
   */
  post?: Post;
}

/**
 * View mode options for the unified Posts section.
 */
export type PostViewMode = "list" | "calendar" | "grid" | "composer";

/**
 * Status filter buckets for the Posts toolbar. `'draft'` matches the contract
 * `Post.status` lifecycle value; the remaining buckets are derived client-side
 * from each Post's per-channel outcomes because the API's own `status`
 * parameter only distinguishes `draft` from `active`.
 */
export type PostStatusFilter = "all" | "scheduled" | "published" | "draft" | "failed";

/**
 * Temporal sort options for ordering post cards, tables, and views.
 */
export type PostSortKey = "date-desc" | "date-asc";

/**
 * Filter and sorting criteria passed to the post processor.
 *
 * `platformFilter` contains zero or more provider identifiers. An empty array means all platforms;
 * multiple identifiers are OR-matched so a post from any selected platform remains visible.
 */
export interface FilterCriteria {
  statusFilter: PostStatusFilter;
  platformFilter: string[];
  profileFilter: string;
  searchQuery: string;
  dateFilter: string;
  sortKey: PostSortKey;
}

/**
 * Calendar day cell metadata used by the calendar grid view.
 */
export interface CalendarDayCell {
  date: Date;
  isCurrentMonth: boolean;
  dayNumber: number;
}

/**
 * Selection state shared by every Posts surface that offers multi-select. The
 * view owns the Map keyed by `Post.id` and the same set survives List/Grid/
 * Calendar switches, so row toggles and "select all visible" controls always
 * project the view's own rows against one identity space.
 */
export interface PostSelectionProps {
  /** `Post.id`s currently selected for bulk actions. */
  selectedIds: ReadonlySet<string>;
  /** Toggles one row's membership; callers pass the row's stable `Post.id`. */
  onToggleSelection: (postId: string) => void;
  /**
   * Applies membership to a set of visible rows at once — the select-all
   * control's honest "current filtered rows only" contract.
   */
  onSetSelection: (postIds: string[], selected: boolean) => void;
  /** Disables every selection control while a bulk operation runs. */
  selectionDisabled?: boolean;
}

/** Owning-profile snapshot for one selected Post; `isDraft` records the draft-filter pruning escape. */
export interface PostSelectionEntry {
  /** Stable `Post.id`. */
  id: string;
  /** Owning Brand Profile id that authorizes deletion of this Post. */
  brandProfileId: string;
  /**
   * Whether the Post was a draft when selected; under the draft-only query the
   * loaded page cannot prove a non-draft Post was deleted, so only draft
   * entries are prunable while that filter narrows the dataset.
   */
  isDraft: boolean;
}

/**
 * Destructive request raised by the detail modal and routed into the view-level
 * confirmation dialog. `delete-post` soft-deletes the whole composition and
 * stops its pending Channels; `cancel-channels` cancels only the listed pending
 * Channel outcomes, leaving every other Channel's result untouched.
 */
export interface PostDestructiveRequest {
  kind: "delete-post" | "cancel-channels";
  /** Stable `Post.id` the request acts on. */
  postId: string;
  /**
   * Owning Brand Profile id captured when the request was raised. `delete-post`
   * authorizes against this explicit identity — never the active scope — so a
   * request raised in the aggregate view still resolves the right profile, and
   * a pending confirmation is immune to a scope switch. `cancel-channels`
   * requests carry the same snapshot field but the cancel mutation does not
   * consume it.
   */
  brandProfileId: string;
  /** Distribution ids to cancel; empty for a whole-Post deletion. */
  distributionIds: string[];
}

/**
 * Props accepted by the unified `PostsView` workspace screen.
 */
export interface PostsViewProps {
  /** Initial view mode ('list', 'calendar', 'grid', 'composer'). Defaults to 'list'. */
  initialViewMode?: PostViewMode;
  /** Initial status filter ('all', 'scheduled', 'published', 'draft', 'failed'). Defaults to 'all'. */
  initialStatusFilter?: PostStatusFilter;
  /** Stable `Post.id` to open in the composer for editing. */
  initialPostId?: string;
  /** Callback for outer workspace navigation. */
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

export const SKELETON_TABLE_KEYS = ["row-sk-1", "row-sk-2", "row-sk-3", "row-sk-4", "row-sk-5"];
export const SKELETON_CARD_KEYS = [
  "card-sk-1",
  "card-sk-2",
  "card-sk-3",
  "card-sk-4",
  "card-sk-5",
  "card-sk-6",
];
