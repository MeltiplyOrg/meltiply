import { Alert } from "@meltiply/ui/alert";
import { useI18n } from "@/lib/i18n";

/** Labels the real app as a synthetic, reset-on-reload preview without replacing its navigation or layout owners. */
export function PreviewNotice() {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-16 z-50 flex justify-center sm:bottom-3">
      <Alert
        role="status"
        variant="info"
        className="w-auto max-w-full px-3 py-2 text-xs shadow-card"
      >
        {t("UI preview · Synthetic data · Refresh resets changes")}
      </Alert>
    </div>
  );
}
