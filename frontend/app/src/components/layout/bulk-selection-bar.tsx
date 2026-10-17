import { createPortal } from "react-dom";
import { LoaderCircle, X, type LucideIcon } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { useI18n } from "@/lib/i18n";

export interface BulkSelectionBarProps {
  count: number;
  actionLabel: string;
  busyLabel: string;
  actionIcon: LucideIcon;
  onClear: () => void;
  onAction: () => void;
  busy?: boolean;
}

/**
 * Gr8r's compact inverse-ink bulk pill, portalled outside clipped collections.
 * Real selection and confirmation stay with callers. No task-only bulk fields
 * are implied; busy state disables both mutation and deselection. The inverse
 * palette adapts to both themes and safe-area padding keeps mobile controls reachable.
 */
export function BulkSelectionBar({
  count,
  actionLabel,
  busyLabel,
  actionIcon: ActionIcon,
  onClear,
  onAction,
  busy = false,
}: BulkSelectionBarProps) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return createPortal(
    <div
      className="fixed bottom-[max(24px,env(safe-area-inset-bottom))] left-1/2 z-40 w-max max-w-[calc(100vw-24px)] -translate-x-1/2"
      data-selection-dock=""
      role="region"
      aria-label={t("Selection actions")}
    >
      <div className="flex min-w-0 items-center gap-1 rounded-window bg-ink p-1.5 pl-3.5 text-ink-inverse shadow-overlay">
        <span
          className="shrink-0 text-(length:--font-size-control) font-semibold tabular-nums"
          role="status"
          aria-live="polite"
        >
          {t("{count} selected", { count })}
        </span>
        <span aria-hidden="true" className="mx-1 h-4.5 w-px shrink-0 bg-ink-inverse/20" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-w-0 gap-1.5 text-ink-inverse opacity-85 hover:bg-ink-inverse/14 hover:text-ink-inverse hover:opacity-100"
          disabled={busy}
          onClick={onAction}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ActionIcon className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{busy ? busyLabel : actionLabel}</span>
        </Button>
        <span aria-hidden="true" className="mx-1 h-4.5 w-px shrink-0 bg-ink-inverse/20" />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-ink-inverse opacity-85 hover:bg-ink-inverse/14 hover:text-ink-inverse hover:opacity-100"
                aria-label={t("Deselect")}
                disabled={busy}
                onClick={onClear}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("Deselect")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>,
    document.body,
  );
}
