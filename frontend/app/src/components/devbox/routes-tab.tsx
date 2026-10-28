import { Loader2, MonitorSmartphone } from "lucide-react";
import { useState } from "react";

import { Button } from "@meltiply/ui/button";

import { authClient } from "@/lib/auth-client";

/**
 * Reads the absolute, same-origin verification URL from a device-code response.
 * Rejects malformed payloads and cross-origin targets so a preview can never
 * navigate outside the installation.
 *
 * @param value - Parsed JSON response body.
 * @returns Absolute same-origin verification URL, or null when unusable.
 */
function devicePreviewDestination(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const target = (value as Record<string, unknown>).verification_uri_complete;
  if (typeof target !== "string") return null;
  try {
    const url = new URL(target, window.location.origin);
    return url.origin === window.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * DevBox tab listing routes added by the current change with a live device
 * request starter. Starting a request uses the real public auth endpoint, then
 * navigates to the consent page so review, approval, and denial render against
 * actual data. In the isolated UI preview the same call is served by the
 * synthetic device handlers and never reaches a backend.
 *
 * @param props.onNavigate - Navigation seam, overridable by tests.
 * @returns Route preview section.
 */
export function RoutesTab({
  onNavigate = (url) => window.location.assign(url),
}: {
  onNavigate?: (url: string) => void;
} = {}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDeviceRequest = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await authClient.requestDeviceAuthorization("device/code", {
        body: JSON.stringify({ client_id: "melti-cli" }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      const body: unknown = await response.json().catch(() => null);
      const destination = response.ok ? devicePreviewDestination(body) : null;
      if (!destination) throw new Error("Device request preview failed");
      onNavigate(destination);
    } catch {
      setError("Could not start a device request. Check the installation and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Route previews" className="grid gap-4">
      <p className="text-xs leading-relaxed text-ink-3">
        Inspect routes added by this change without preparing a terminal or copying credentials.
      </p>
      <div className="rounded-card border border-line bg-canvas p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs font-medium text-ink">/device</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              Browser consent, review, and terminal outcomes for melti-cli.
            </p>
          </div>
          <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden="true" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void startDeviceRequest()}>
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            {busy ? "Starting…" : "Start device request"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate(new URL("/device", window.location.origin).href)}
          >
            Open entry page
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs leading-relaxed text-red">
            {error}
          </p>
        )}
      </div>
      <p className="text-xs leading-relaxed text-ink-3">
        Starting creates a real ten-minute request on this installation. Approve or deny it to
        inspect both terminal states. No CLI session is minted.
      </p>
    </section>
  );
}
