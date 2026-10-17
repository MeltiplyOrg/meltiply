import React from "react";
import { StatusPill, type StatusPillTone } from "@meltiply/ui/status-pill";
import { useI18n } from "@/lib/i18n";

/**
 * Maps a contract `DistributionStatus` (or a Post's `'draft'` state) onto the
 * shared pill tone. In-flight states share the scheduled accent; stuck
 * `needs_reconciliation` is orange so it never reads as healthy scheduling.
 */
const TONE_BY_STATUS: Record<string, StatusPillTone> = {
  published: "green",
  failed: "red",
  needs_reconciliation: "orange",
  draft: "neutral",
  cancelled: "neutral",
  cancel_requested: "neutral",
};

/**
 * Post/Channel status label rendered through the shared `StatusPill`, so posts
 * and channels use one status treatment. Labels come from `tStatus`; unknown
 * statuses fall back to the accent (scheduled) tone. Memoized for long feeds.
 *
 * @example <StatusBadge status="failed" /> → red pill labelled "Failed"
 */
export const StatusBadge = React.memo(function StatusBadge({
  status,
  className,
  compact = false,
}: {
  /** Channel outcome status (contract `DistributionStatus`) or the Post's `'draft'` state. */
  status: string;
  className?: string;
  /** Flat Tasks-row treatment; retains the shared status tone and text. */
  compact?: boolean;
}) {
  const { tStatus } = useI18n();
  const key = status.toLowerCase();
  return (
    <StatusPill
      tone={TONE_BY_STATUS[key] ?? "accent"}
      variant={compact ? "plain" : "badge"}
      className={className}
    >
      {tStatus(key)}
    </StatusPill>
  );
});
