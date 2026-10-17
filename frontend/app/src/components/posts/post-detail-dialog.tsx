import React, { useState } from "react";
import {
  CalendarDays,
  Edit3,
  Trash2,
  RotateCw,
  ExternalLink,
  Clock,
  TriangleAlert,
  Images,
  Ellipsis,
  CircleDot,
  Share2,
} from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { SideDialog } from "@meltiply/ui/side-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { StatusBadge } from "./status-badge";
import { toast } from "@meltiply/ui/toast";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useRetryDistribution, useUpdateScheduledDistribution } from "@/lib/queries";
import { useI18n } from "@/lib/i18n";
import { platformDisplayName } from "@/lib/platforms";
import {
  isCancellableStatus,
  resolveCancellableDistributionIds,
  resolveRowCaption,
  normalizePostStatus,
} from "./posts-helpers";
import type { PostDestructiveRequest, PostDetailItem, PostRow } from "./types";

export interface PostDetailDialogProps {
  /** Post row to inspect; `null` closes the dialog. */
  post: PostRow | null;
  /**
   * Whether scope-owned mutations are allowed; `false` in the aggregate
   * "All Brand Profiles" view. Post deletion no longer consumes this flag —
   * the Post's own `brand_profile_id` authorizes it — so only edit, retry,
   * reschedule, and channel cancels stay gated.
   */
  canMutate: boolean;
  onClose: () => void;
  /** Opens the composer for a Post that still has an editable surface. */
  onEdit: (postId: string) => void;
  /** Routes a destructive cancel/delete request to the view-level CenterAlertDialog. */
  onRequestDelete: (request: PostDestructiveRequest) => void;
}
/**
 * Formats an ISO timestamp into the source views' `en-US` display form
 * (e.g. 'Sep 14, 2026, 02:30 PM'). Returns null for missing/invalid input so
 * callers can omit the row entirely.
 */
function formatPostDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Converts an ISO timestamp into the local `YYYY-MM-DDTHH:mm` shape required by
 * `datetime-local` inputs, pre-filling the reschedule picker with the current slot.
 */
function toLocalInputValue(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  if (isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Per-channel detail row: platform icon, localized status pill, schedule/publish
 * timestamps, provider failure message, outbound post link, and the contract-real
 * actions (retry, reschedule, cancel) gated by distribution lifecycle state.
 *
 * A saved target with no outcome yet renders as a pending destination with its
 * own caption/media override notes, because adding or removing a pending Channel
 * is a target edit and never touches another Channel's published result.
 *
 * Retry and reschedule mutations live here because they need no confirmation;
 * destructive cancel/delete requests bubble to the view-level CenterAlertDialog via
 * `onRequestDelete`.
 */
function ChannelOutcomeRow({
  item,
  postAttachments,
  canMutate,
  onRequestDelete,
}: {
  item: PostDetailItem;
  /** Ordered attachments of the owning Post, for pending-override comparison. */
  postAttachments: number;
  /** False in the aggregate view: retry/reschedule/cancel stay hidden. */
  canMutate: boolean;
  onRequestDelete: (distributionIds: string[]) => void;
}) {
  const { t } = useI18n();
  const scope = useSessionScope();
  const retry = useRetryDistribution(scope);
  const reschedule = useUpdateScheduledDistribution(scope);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleValue, setRescheduleValue] = useState("");

  const distribution = item.distribution;
  const status = item.status;
  const channelName =
    item.integration?.name ?? (distribution ? platformDisplayName(distribution.platform) : null);
  const provider = item.integration?.providerIdentifier ?? distribution?.platform ?? "";
  const scheduledLabel = formatPostDate(distribution?.scheduled_at);
  const publishedLabel = formatPostDate(distribution?.published_at);
  const cancellable = distribution ? isCancellableStatus(status) : false;
  const attachmentSelection = item.target?.attachment_ids ?? null;
  // Only a pending target narrows against the current Post; a claimed
  // Channel's frozen media count is not comparable to the edited Post's, and
  // its overrides likewise describe pending intent, not delivered content.
  const narrowsMedia =
    !distribution?.publication &&
    attachmentSelection !== null &&
    attachmentSelection.length !== postAttachments;
  const hasCaptionOverride =
    !distribution?.publication &&
    Boolean(item.target?.title_override ?? item.target?.description_override ?? null);

  /**
   * Applies the picked datetime-local value through `useUpdateScheduledDistribution`.
   * No-op when the input is empty or unparsable so the mutation never receives garbage.
   */
  const applyReschedule = () => {
    if (!distribution || !rescheduleValue) return;
    const next = new Date(rescheduleValue);
    if (isNaN(next.getTime())) return;
    reschedule
      .mutateAsync({ id: distribution.id, input: { scheduled_at: next.toISOString() } })
      .then(() => {
        setRescheduleOpen(false);
        toast(t("Post rescheduled"), {
          description: t("{channel} scheduled for {date}", {
            channel: channelName ?? platformDisplayName(provider),
            date: formatPostDate(next.toISOString()) ?? next.toLocaleString("en-US"),
          }),
          variant: "success",
        });
      })
      .catch(() => {
        toast(t("Could not reschedule this post"), {
          description: t("We could not complete that request. Try again in a moment."),
          variant: "error",
        });
      });
  };

  /**
   * Retries a failed distribution through `useRetryDistribution`, surfacing the
   * outcome as a toast since the list refreshes via query invalidation.
   */
  const applyRetry = () => {
    if (!distribution) return;
    retry
      .mutateAsync(distribution.id)
      .then(() =>
        toast(t("Retry queued"), {
          description: channelName ?? platformDisplayName(provider),
          variant: "success",
        }),
      )
      .catch(() =>
        toast(t("Could not retry this post"), {
          description: t("We could not complete that request. Try again in a moment."),
          variant: "error",
        }),
      );
  };

  return (
    <article
      aria-label={channelName ?? t("Unassigned channel")}
      className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface shadow-hairline">
            <PlatformIcon provider={provider} className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink truncate">
              {channelName ?? t("Unassigned channel")}
            </p>
            <p className="text-[11px] text-ink-3 truncate">
              {provider ? platformDisplayName(provider) : t("No platform")}
            </p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {!distribution && (
        <p className="text-[11.5px] text-ink-2">
          {t(
            "Saved destination — not scheduled yet. Scheduling or removing this Channel leaves every other Channel's result unchanged.",
          )}
        </p>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
        {scheduledLabel && (
          <div className="flex items-center gap-1.5 text-ink-2">
            <Clock className="size-3 text-ink-3" />
            <dt className="text-ink-3">{t("Scheduled")}:</dt>
            <dd className="font-medium">{scheduledLabel}</dd>
          </div>
        )}
        {publishedLabel && (
          <div className="flex items-center gap-1.5 text-ink-2">
            <Clock className="size-3 text-ink-3" />
            <dt className="text-ink-3">{t("Published")}:</dt>
            <dd className="font-medium">{publishedLabel}</dd>
          </div>
        )}
        {item.attachments.length > 0 && (
          <div className="flex items-center gap-1.5 text-ink-2">
            <Images className="size-3 text-ink-3" />
            <dt className="text-ink-3">{t("Attachments")}:</dt>
            <dd className="font-medium">
              {narrowsMedia
                ? t("{count} of {total} ordered", {
                    count: item.attachments.length,
                    total: postAttachments,
                  })
                : t("{count} ordered", { count: item.attachments.length })}
            </dd>
          </div>
        )}
      </dl>

      {hasCaptionOverride && (
        <p className="text-[11.5px] text-ink-2">
          {t("This Channel publishes its own caption for the post.")}
        </p>
      )}

      {status === "needs_reconciliation" && (
        <p className="flex items-start gap-1.5 text-[11.5px] text-orange">
          <TriangleAlert className="size-3.5 shrink-0 mt-px" />
          {t(
            "This post's state could not be confirmed with the platform. It may need manual review.",
          )}
        </p>
      )}

      {item.errorMessage && (
        <p className="rounded-control border border-red/20 bg-red-tint px-2 py-1.5 text-[11.5px] text-red">
          {item.errorMessage}
        </p>
      )}

      {distribution?.platform_url && (
        <a
          href={distribution.platform_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-accent-ink hover:underline w-fit"
        >
          <ExternalLink className="size-3" />
          {t("View on {platform}", { platform: platformDisplayName(provider) })}
        </a>
      )}

      {canMutate && distribution && (status === "failed" || cancellable) && (
        <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1 border-t border-line/60">
          {status === "failed" && (
            <Button
              variant="outline"
              size="sm"
              disabled={retry.isPending}
              onClick={applyRetry}
              className="h-7 text-xs rounded-control gap-1"
            >
              <RotateCw className="size-3" />
              {retry.isPending ? t("Retrying…") : t("Retry")}
            </Button>
          )}
          {cancellable && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRescheduleValue(toLocalInputValue(distribution.scheduled_at));
                  setRescheduleOpen((open) => !open);
                }}
                className="h-7 text-xs rounded-control gap-1"
              >
                <CalendarDays className="size-3" />
                {t("Reschedule")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRequestDelete([distribution.id])}
                className="h-7 text-xs rounded-control text-destructive border-destructive/30 hover:bg-destructive/10 gap-1"
              >
                <Trash2 className="size-3" />
                {t("Cancel")}
              </Button>
            </>
          )}
        </div>
      )}

      {canMutate && rescheduleOpen && cancellable && (
        <div className="flex items-center gap-2 rounded-control border border-line bg-surface p-2">
          <Input
            type="datetime-local"
            value={rescheduleValue}
            onChange={(event) => setRescheduleValue(event.target.value)}
            className="h-8 flex-1 rounded-control border border-line bg-page px-2 text-xs text-ink focus:border-line-strong focus:outline-none"
          />
          <Button
            variant="default"
            size="sm"
            disabled={reschedule.isPending || !rescheduleValue}
            onClick={applyReschedule}
            className="h-8 text-xs rounded-control"
          >
            {reschedule.isPending ? t("Saving…") : t("Apply")}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * Post detail dialog: inspects one durable Post in the shared right-side panel,
 * supplying its localized Close label directly; displays its full shared
 * caption, ordered attachment strip, and one row per Channel
 * carrying that Channel's independent status, failure message, timestamps,
 * outbound platform link, and the contract-real retry/reschedule/cancel actions.
 * Every action keeps the Post identity, so editing or retrying one Channel never
 * rewrites another's result.
 *
 * The shared Gr8r drawer owns scroll, expansion, dismissal, and opener focus.
 * Compact breadcrumb/action chrome frames flat property rows, the full caption,
 * ordered attachments, and real per-channel outcomes. No task-only properties
 * or editable publication status are copied from the reference.
 *
 * Destructive affordances state their Platform consequence: cancelling a pending
 * Channel and deleting a Post both leave anything already published live on its
 * platform. `post === null` closes the panel; the last post stays rendered
 * through dismissal so content never blanks during the shared fade.
 */
export const PostDetailDialog = React.memo(function PostDetailDialog({
  post: livePost,
  canMutate,
  onClose,
  onEdit,
  onRequestDelete,
}: PostDetailDialogProps) {
  const { t } = useI18n();
  const post = useLatchedValue(livePost);
  if (!post) return null;

  const caption = resolveRowCaption(post);
  const dateLabel = formatPostDate(post.date);
  const attachments = post.post?.attachments ?? [];
  const isDraft = post.post?.status === "draft";
  const cancellableIds = resolveCancellableDistributionIds(post);
  const editable = Boolean(isDraft || cancellableIds.length > 0);

  const status = normalizePostStatus(post);

  return (
    <SideDialog
      closeLabel={t("Close")}
      open={livePost !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("Post details")}
      contentKey={post.id}
      breadcrumb={
        <span className="flex min-w-0 items-center gap-2">
          <span>{t("Posts")}</span>
          <span className="text-ink-3">/</span>
          <code className="truncate text-(length:--font-size-micro) text-ink-3" title={post.id}>
            {post.id.slice(0, 8)}
          </code>
        </span>
      }
      description={
        dateLabel
          ? t("{count} channel(s) · {date}", { count: post.channels.length, date: dateLabel })
          : t("{count} channel(s)", { count: post.channels.length })
      }
      actions={
        <>
          {canMutate && editable && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-(length:--font-size-control)"
              onClick={() => onEdit(post.id)}
            >
              <Edit3 className="size-3.5" />
              {t("Edit post")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t("Post actions")}>
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canMutate && cancellableIds.length > 0 && (
                <DropdownMenuItem
                  className="text-red focus:text-red"
                  onSelect={() =>
                    onRequestDelete({
                      kind: "cancel-channels",
                      postId: post.id,
                      brandProfileId: post.brandProfileId,
                      distributionIds: cancellableIds,
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                  {t("Cancel all pending")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-red focus:text-red"
                onSelect={() =>
                  onRequestDelete({
                    kind: "delete-post",
                    postId: post.id,
                    brandProfileId: post.brandProfileId,
                    distributionIds: [],
                  })
                }
              >
                <Trash2 className="size-3.5" />
                {isDraft ? t("Delete draft") : t("Delete post")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <h2 className="text-(length:--text-title) font-semibold leading-snug tracking-tight text-ink">
        {post.post?.title || t("Post details")}
      </h2>
      <dl className="mt-3 grid grid-cols-[112px_minmax(0,1fr)] items-center gap-y-0.5 text-(length:--font-size-control)">
        <dt className="flex min-h-control items-center gap-1.75 text-ink-2">
          <CircleDot className="size-3.5 text-ink-3" />
          {t("Status")}
        </dt>
        <dd>
          <StatusBadge status={status} compact />
        </dd>
        <dt className="flex min-h-control items-center gap-1.75 text-ink-2">
          <Share2 className="size-3.5 text-ink-3" />
          {t("Channels")}
        </dt>
        <dd className="text-ink">{post.channels.length}</dd>
        {dateLabel && (
          <>
            <dt className="flex min-h-control items-center gap-1.75 text-ink-2">
              <CalendarDays className="size-3.5 text-ink-3" />
              {isDraft ? t("Created") : t("Publish date")}
            </dt>
            <dd className="text-ink">{dateLabel}</dd>
          </>
        )}
      </dl>
      <section className="mt-6.5">
        <h3 className="mb-2 text-(length:--font-size-ui) font-semibold">{t("Caption")}</h3>
        <p className="whitespace-pre-wrap break-words text-(length:--font-size-ui) leading-relaxed text-ink-2">
          {caption || t("No caption")}
        </p>
      </section>

      {attachments.length > 0 && (
        <section className="mt-6.5">
          <h3 className="mb-2 flex items-center gap-2 text-(length:--font-size-ui) font-semibold">
            {t("Attachments")}
            <span className="text-xs font-normal text-ink-3">{attachments.length}</span>
          </h3>
          <div className="flex items-center gap-2 overflow-x-auto">
            {attachments.map((attachment) => {
              const path = attachment.asset.thumbnail_url ?? attachment.asset.download_url ?? null;
              return (
                <div
                  key={attachment.asset_id}
                  className="size-12 shrink-0 overflow-hidden rounded-control border border-line bg-page flex items-center justify-center"
                >
                  {path ? (
                    <img src={path} alt="" className="size-full object-cover" />
                  ) : (
                    <Images className="size-4 text-ink-3" />
                  )}
                </div>
              );
            })}
            <span className="text-[11px] text-ink-3 shrink-0">
              {t("{count} ordered attachment(s)", { count: attachments.length })}
            </span>
          </div>
        </section>
      )}

      <section className="mt-6.5">
        <h3 className="mb-2 flex items-center gap-2 text-(length:--font-size-ui) font-semibold">
          {t("Channels")}
          <span className="text-xs font-normal text-ink-3">{post.channels.length}</span>
        </h3>
        {post.channels.map((item) => (
          <ChannelOutcomeRow
            key={item.id}
            item={item}
            postAttachments={attachments.length}
            canMutate={canMutate}
            onRequestDelete={(ids) =>
              onRequestDelete({
                kind: "cancel-channels",
                postId: post.id,
                brandProfileId: post.brandProfileId,
                distributionIds: ids,
              })
            }
          />
        ))}
      </section>
    </SideDialog>
  );
});
