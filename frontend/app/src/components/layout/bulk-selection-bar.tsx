import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { useI18n } from "@/lib/i18n";

export interface BulkSelectionBarProps {
  count: number;
  actionLabel: string;
  busyLabel: string;
  onClear: () => void;
  onAction: () => void;
  busy?: boolean;
}

/**
 * Portals a shared bulk-action pill outside clipped route surfaces. It exists
 * only while callers own a selection; callers also own action behavior and
 * pending state, including destructive confirmation.
 */
export function BulkSelectionBar({
  count,
  actionLabel,
  busyLabel,
  onClear,
  onAction,
  busy = false,
}: BulkSelectionBarProps) {
  const { t } = useI18n();

  if (count <= 0) return null;

  return createPortal(
    <div
      className="fixed bottom-[max(12px,env(safe-area-inset-bottom))] left-1/2 z-40 w-max max-w-[calc(100vw-24px)] -translate-x-1/2"
      data-selection-dock=""
      role="region"
      aria-label={t("Selection actions")}
    >
      <div className="flex min-w-0 items-center gap-2 rounded-full border border-line-strong bg-surface p-1.5 pl-4 shadow-overlay">
        <span
          className="shrink-0 text-xs font-semibold tabular-nums text-ink"
          role="status"
          aria-live="polite"
        >
          {t("{count} selected", { count })}
        </span>
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-full"
          disabled={busy}
          onClick={onClear}
        >
          <X className="size-3.5" aria-hidden="true" />
          {t("Deselect")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="min-w-0 rounded-full"
          disabled={busy}
          onClick={onAction}
        >
          {busy && <LoaderCircle className="size-3.5" aria-hidden="true" />}
          <span className="truncate">{busy ? busyLabel : actionLabel}</span>
        </Button>
      </div>
    </div>,
    document.body,
  );
}
