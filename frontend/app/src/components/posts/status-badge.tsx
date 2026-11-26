import React from "react";
import { StatusPill } from "@meltiply/ui/status-pill";
import { useI18n } from "@/lib/i18n";
import { resolvePublicationStatus } from "@/lib/publication-status";
import { publicationStatusPresentation } from "./status-presentation";

export const StatusBadge = React.memo(function StatusBadge({
  status,
  className,
  compact = false,
}: {
  status: string;
  className?: string;
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
