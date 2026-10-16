import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
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
 * Portals the shared directory-selection pill outside clipped route surfaces.
 * Presence retains it for a short bottom-up entrance/downward exit; manual or OS
 * low motion settles instantly. Callers own selection and destructive confirmation.
 */
export function BulkSelectionBar(props: BulkSelectionBarProps) {
  return createPortal(
    <AnimatePresence>
      {props.count > 0 && <SelectionPill key="selection" {...props} />}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Keeps count changes immediate while animating only the pill's presence.
 * Exiting controls become inert and hidden to assistive technology immediately;
 * the shared motion preference disables travel and duration without remounting.
 */
function SelectionPill({
  count,
  actionLabel,
  busyLabel,
  onClear,
  onAction,
  busy = false,
}: BulkSelectionBarProps) {
  const { t } = useI18n();
  const { lowMotion } = useMotionPreference();
  const isPresent = useIsPresent();

  return (
    <motion.div
      className="bulk-selection-dock"
      role="region"
      aria-label={t("Selection actions")}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
      initial={lowMotion ? false : { opacity: 0, transform: "translateY(16px) scale(0.97)" }}
      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
      exit={{
        opacity: 0,
        transform: lowMotion ? "translateY(0px) scale(1)" : "translateY(12px) scale(0.98)",
      }}
      transition={{ duration: lowMotion ? 0 : isPresent ? 0.22 : 0.15, ease: [0.23, 1, 0.32, 1] }}
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
    </motion.div>
  );
}
