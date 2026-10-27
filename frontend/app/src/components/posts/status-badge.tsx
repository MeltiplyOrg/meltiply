import React from "react";
import { StatusPill } from "@meltiply/ui/status-pill";
import { useI18n } from "@/lib/i18n";
import { resolvePublicationStatus } from "@/lib/publication-status";
import { publicationStatusPresentation } from "./status-presentation";

/**
 * Post/Channel status label rendered through the shared `StatusPill`, so posts
 * and channels use one status treatment. The canonical mapping supplies both
 * tone and label; unrecognized values render as a neutral "Unknown" badge
 * instead of falling back to the scheduled accent. Memoized for long feeds.
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
  const canonical = resolvePublicationStatus(status);
  const { tone } = publicationStatusPresentation(canonical);
  return (
    <StatusPill tone={tone} variant={compact ? "plain" : "badge"} className={className}>
      {tStatus(canonical)}
    </StatusPill>
  );
});
