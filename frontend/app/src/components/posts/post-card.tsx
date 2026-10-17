import { CalendarDays, FileText, Paperclip, Play } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { useI18n } from "@/lib/i18n";
import { PostActions, type PostActionsProps } from "./post-actions";
import { StatusBadge } from "./status-badge";
import {
  normalizePostStatus,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
} from "./posts-helpers";
import type { PostRow } from "./types";

export interface PostCardProps extends PostActionsProps {
  post: PostRow;
  profileName: string;
  selected: boolean;
  selectionDisabled?: boolean;
  onToggleSelection: (postId: string) => void;
}

/**
 * Canonical media Grid card over real caption, profile, channel, date, and
 * attachment data. The title button's stretched hit area opens inspection with
 * native keyboard semantics; selection and quick actions sit above that area.
 */
export function PostCard({
  post,
  postId,
  profileName,
  selected,
  selectionDisabled,
  onToggleSelection,
  ...actions
}: PostCardProps) {
  const { t } = useI18n();
  const providers = resolveRowProviders(post);
  const preview = resolveRowPreviewAttachment(post);
  const image = preview?.asset.thumbnail_url ?? preview?.asset.download_url;
  const attachments = post.post?.attachments.length ?? 0;
  return (
    <article
      className="group/card relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-card border border-line bg-surface px-3 py-2.5 shadow-card hover:border-line-strong data-[selected=true]:border-accent"
      data-selected={selected || undefined}
    >
      <div className="flex min-w-0 max-w-[calc(100%-24px)] items-center gap-1.5 truncate text-(length:--font-size-micro) text-ink-3">
        <span className="size-1.75 shrink-0 rounded-chip bg-accent" />
        <span>{profileName}</span>
      </div>
      <Button
        variant="ghost"
        data-post-details
        className="h-auto justify-start whitespace-normal p-0 text-left text-(length:--font-size-ui) font-normal leading-snug text-ink after:absolute after:inset-0 after:rounded-card hover:bg-transparent"
        title={t("View details")}
        onClick={(event) => {
          event.stopPropagation();
          actions.onViewDetails(postId);
        }}
      >
        {resolveRowCaption(post) || t("Untitled post")}
      </Button>
      <div className="relative flex h-35 items-center justify-center overflow-hidden rounded-chip bg-inset">
        {image ? (
          <>
            <img src={image} alt="" className="size-full object-cover" />
            {preview?.asset.asset_type === "video" && (
              <Play className="absolute size-5.5 text-ink-inverse" />
            )}
          </>
        ) : (
          <FileText className="size-6 text-ink-3" />
        )}
      </div>
      <StatusBadge status={normalizePostStatus(post)} compact />
      <div className="flex min-h-4.5 flex-wrap items-center gap-2 text-(length:--font-size-micro) text-ink-3">
        <span className="shrink-0 font-mono">{postId.slice(0, 8)}</span>
        <span className="flex items-center gap-1">
          {providers.map((provider) => (
            <PlatformIcon key={provider} provider={provider} className="size-3" />
          ))}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <CalendarDays className="size-3" />
          <time dateTime={post.date}>
            {new Date(post.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </time>
        </span>
        {attachments > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1">
            <Paperclip className="size-3" />
            {attachments}
          </span>
        )}
        <Input
          type="checkbox"
          className="relative z-10 ml-auto size-3.25"
          aria-label={t("Select post")}
          checked={selected}
          disabled={selectionDisabled}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggleSelection(postId)}
        />
      </div>
      <div className="absolute right-1.5 top-1.5 z-10 rounded-control bg-surface">
        <PostActions postId={postId} {...actions} />
      </div>
    </article>
  );
}
