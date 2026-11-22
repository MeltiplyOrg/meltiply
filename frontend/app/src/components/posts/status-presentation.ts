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

export interface PublicationStatusPresentation {
  tone: StatusPillTone;
  Icon: LucideIcon;
}

const PRESENTATION: Record<
  ReturnType<typeof resolvePublicationStatus>,
  PublicationStatusPresentation
> = {
  draft: { tone: "neutral", Icon: FileText },
  scheduled: { tone: "accent", Icon: Clock },
  queued: { tone: "accent", Icon: Clock },
  processing: { tone: "accent", Icon: Clock },
  awaiting_provider: { tone: "accent", Icon: Clock },
  delivered: { tone: "neutral", Icon: FileText },
  published: { tone: "green", Icon: CircleCheck },
  failed: { tone: "red", Icon: AlertCircle },
  needs_reconciliation: { tone: "orange", Icon: TriangleAlert },
  cancel_requested: { tone: "orange", Icon: Ban },
  cancelled: { tone: "neutral", Icon: CircleX },
  unknown: { tone: "neutral", Icon: CircleHelp },
};

export function publicationStatusPresentation(status: string): PublicationStatusPresentation {
  return PRESENTATION[resolvePublicationStatus(status)];
}

export const PUBLICATION_ICON_TONE: Record<StatusPillTone, string> = {
  accent: "text-accent",
  green: "text-green",
  orange: "text-orange",
  red: "text-red",
  neutral: "text-ink-3",
};
