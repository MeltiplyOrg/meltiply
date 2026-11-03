import React from "react";
import {
  CalendarDays,
  Eye,
  FileText,
  Heart,
  MessageCircle,
  Paperclip,
  Play,
  Share2,
} from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Card, CardFooter } from "@meltiply/ui/card";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { useI18n } from "@/lib/i18n";
import { usePublishingTimeZone } from "@/context/publishing-timezone.context";
import { abbreviateRecordId, postDateFormatters } from "@/lib/format";
import {
  formatAnalyticsCompact,
  formatAnalyticsInteger,
} from "@/components/analytics/analytics-helpers";
import { postAnalyticsColumns } from "./post-view-options";
import { PostActions, type PostActionsProps } from "./post-actions";
import { StatusBadge } from "./status-badge";
import {
  normalizePostStatus,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
} from "./posts-helpers";
import type { PostRow } from "./types";

/** Card metric icons, rendered in the stored-analytics footer. */
const CARD_METRICS = [
  { key: "views", icon: Eye },
  { key: "likes", icon: Heart },
  { key: "comments", icon: MessageCircle },
  { key: "shares", icon: Share2 },
] as const;

export interface PostCardProps extends PostActionsProps {
  post: PostRow;
  profileName: string;
  selected: boolean;
  selectionDisabled?: boolean;
  onToggleSelection: (postId: string) => void;
  onViewDetails: (postId: string) => void;
}

/**
 * Canonical media Grid card over real caption, profile, channel, date, and
 * attachment data, followed by one non-wrapping icon-led analytics footer.
 * Four essential latest stored counters use compact locale formatting; exact
 * values stay accessible. Draft, unpublished, and unmeasured counters show a
 * dash, while measured zeros remain zero. No per-card network reads are made.
 * The title button's stretched hit area opens inspection with native keyboard
 * semantics; selection and quick actions sit above that area.
 */
export const PostCard = React.memo(function PostCard({
  post,
  postId,
  profileName,
  selected,
  selectionDisabled,
  onToggleSelection,
  ...actions
}: PostCardProps) {
  const { t, language } = useI18n();
  const timeZone = usePublishingTimeZone();
  const dateFormat = postDateFormatters(timeZone).day;
  const providers = resolveRowProviders(post);
  const preview = resolveRowPreviewAttachment(post);
  const image = preview?.asset.thumbnail_url ?? preview?.asset.download_url;
  const attachments = post.post?.attachments.length ?? 0;
  const analytics =
    post.post?.status !== "draft" && post.channels.some((channel) => channel.status === "published")
      ? post.post?.analytics
      : null;
  const labels = new Map(postAnalyticsColumns(t).map((column) => [column.id, column.name]));
  return (
    <Card
      role="article"
      className="group/card relative flex min-w-0 cursor-pointer flex-col gap-2 px-3 py-2.5 hover:border-line-strong data-[selected=true]:border-accent"
      data-selected={selected || undefined}
    >
      <div className="flex min-w-0 max-w-[calc(100%-24px)] items-center gap-1.5 truncate text-(length:--font-size-micro) text-ink-3">
        <span className="size-1.75 shrink-0 rounded-chip bg-accent" />
        <span>{profileName}</span>
      </div>
      <Button
        variant="ghost"
        data-post-details
        className="h-auto justify-start whitespace-normal p-0 text-left text-(length:--font-size-ui) font-normal leading-snug text-ink after:absolute after:inset-0 after:z-1 after:rounded-card hover:bg-transparent"
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
            <img
              src={image}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover"
            />
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
        <span className="shrink-0 font-mono" title={postId}>
          {abbreviateRecordId(postId)}
        </span>
        <span className="flex items-center gap-1">
          {providers.map((provider) => (
            <PlatformIcon key={provider} provider={provider} className="size-3" />
          ))}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <CalendarDays className="size-3" />
          <time dateTime={post.date}>{dateFormat.format(new Date(post.date))}</time>
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
      <CardFooter className="mt-auto min-w-0 border-t border-line px-0 pb-0 pt-2">
        <dl
          aria-label={t("Analytics")}
          className="grid w-full min-w-0 grid-cols-4 gap-2 whitespace-nowrap text-(length:--font-size-micro) text-ink-3"
        >
          {CARD_METRICS.map(({ key, icon: Icon }) => {
            const value = analytics?.[key];
            const label = labels.get(key);
            const exact =
              value == null ? t("Not measured") : formatAnalyticsInteger(value, language);
            return (
              <div
                key={key}
                className="flex min-w-0 items-center gap-1"
                title={`${label}: ${exact}`}
              >
                <dt>
                  <Icon aria-hidden="true" className="size-3 shrink-0" />
                  <span className="sr-only">{label}</span>
                </dt>
                <dd className="min-w-0 truncate font-mono tabular-nums">
                  <span aria-hidden="true">
                    {value == null ? "—" : formatAnalyticsCompact(value, language)}
                  </span>
                  <span className="sr-only">{exact}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      </CardFooter>
      <div className="absolute right-1.5 top-1.5 z-10 rounded-control bg-surface">
        <PostActions postId={postId} {...actions} />
      </div>
    </Card>
  );
});
