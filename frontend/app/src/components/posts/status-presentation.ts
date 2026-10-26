import {
  AlertCircle,
  Ban,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  FileText,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { StatusPillTone } from "@meltiply/ui/status-pill";
import { resolvePublicationStatus } from "@/lib/publication-status";

/** How one publication status renders: shared pill tone and status icon. */
export interface PublicationStatusPresentation {
  tone: StatusPillTone;
  Icon: LucideIcon;
}

/**
 * The single presentation map for publication status. In-flight states share
 * the scheduled accent; Reconciliation and an in-progress cancellation are
 * orange caution; terminal cancellation and unknown values are neutral. Unknown
 * is never accent, so it cannot read as scheduled.
 */
const PRESENTATION: Record<
  ReturnType<typeof resolvePublicationStatus>,
  PublicationStatusPresentation
> = {
  draft: { tone: "neutral", Icon: FileText },
  scheduled: { tone: "accent", Icon: Clock },
  queued: { tone: "accent", Icon: Clock },
  processing: { tone: "accent", Icon: Clock },
  awaiting_provider: { tone: "accent", Icon: Clock },
  published: { tone: "green", Icon: CircleCheck },
  failed: { tone: "red", Icon: AlertCircle },
  needs_reconciliation: { tone: "orange", Icon: TriangleAlert },
  cancel_requested: { tone: "orange", Icon: Ban },
  cancelled: { tone: "neutral", Icon: CircleX },
  unknown: { tone: "neutral", Icon: CircleHelp },
};

/** Resolves the tone and icon for any raw publication status. */
export function publicationStatusPresentation(status: string): PublicationStatusPresentation {
  return PRESENTATION[resolvePublicationStatus(status)];
}

/** Icon foreground per tone, shared by compact calendar chips. */
export const PUBLICATION_ICON_TONE: Record<StatusPillTone, string> = {
  accent: "text-accent",
  green: "text-green",
  orange: "text-orange",
  red: "text-red",
  neutral: "text-ink-3",
};
