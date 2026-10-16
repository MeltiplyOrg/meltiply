import { useEffect, useState } from "react";

import { Button } from "@meltiply/ui/button";

import { runtimeStatusEvent, type RuntimeStatusDetail } from "@/lib/runtime-events";
import { useI18n } from "@/lib/i18n";

const titles: Record<RuntimeStatusDetail["kind"], string> = {
  "active-organization": "Choose an organization",
  "auth-expired": "Your session expired",
  maintenance: "Meltiply is temporarily unavailable",
  offline: "You are offline",
  recoverable: "Meltiply could not refresh this view",
};

/**
 * Fixed overlay banner rendering global runtime health notifications without shifting page layout.
 * Listens to browser network status (offline/online) and custom `runtimeStatusEvent` notices
 * (expired authentication, active organization requirement, maintenance, or recoverable query failures).
 * Uses polite live regions for offline status and assertive live alerts for urgent states,
 * and includes contextual action links and an explicit dismiss button.
 *
 * @returns A fixed-position alert or status banner element, or null when no status is active.
 */
export function RuntimeStatus(): React.ReactElement | null {
  const [status, setStatus] = useState<RuntimeStatusDetail | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    const onRuntimeStatus = (event: Event) => {
      setStatus((event as CustomEvent<RuntimeStatusDetail | null>).detail);
    };
    const onOffline = () =>
      setStatus({
        kind: "offline",
        message: "Changes are paused until your connection returns.",
      });
    const onOnline = () => setStatus((current) => (current?.kind === "offline" ? null : current));

    window.addEventListener(runtimeStatusEvent, onRuntimeStatus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    if (!navigator.onLine) onOffline();

    return () => {
      window.removeEventListener(runtimeStatusEvent, onRuntimeStatus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  if (!status) return null;

  // Only an expired session has somewhere to go; the other states can be
  // dismissed, and `active-organization` has no in-app remedy to link to.
  const action =
    status.kind === "auth-expired" ? { href: "/sign-in", label: "Sign in again" } : null;

  return (
    <div
      role={status.kind === "offline" ? "status" : "alert"}
      aria-live={status.kind === "offline" ? "polite" : "assertive"}
      className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-ink/15 bg-canvas px-4 py-3 text-ink shadow-card">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(titles[status.kind])}</p>
          <p className="text-sm text-ink-2">{t(status.message)}</p>
        </div>
        {action && (
          <a
            href={action.href}
            className="rounded-lg border border-ink/15 bg-inset px-3.5 py-2 text-sm font-medium outline-none transition-colors duration-150 hover:text-red focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            {t(action.label)}
          </a>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setStatus(null)}
          className="rounded-lg px-3 py-2 text-sm font-medium text-ink-2 outline-none transition-colors duration-150 hover:text-red focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          {t("Dismiss")}
        </Button>
      </div>
    </div>
  );
}
