import { useEffect, useRef, useState } from "react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { copyText } from "@meltiply/ui/copy-text";
import {
  CenterAlertDialog,
  CenterAlertDialogAction,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useBroadcastControls } from "@/lib/queries";
import type { BroadcastInfo } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/**
 * Reveals encoder credentials only after a writer's explicit request, in local
 * component state rather than a persisted/query cache. Hiding or unmounting
 * aborts reads and discards secrets. Ending requires a separate confirmation
 * and reuses the durable mutation key on an uncertain response.
 */
export function BroadcastControls({ distributionId }: { distributionId: string }) {
  const { t } = useI18n();
  const controls = useBroadcastControls(useSessionScope());
  const [info, setInfo] = useState<BroadcastInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  /** Fetches the current provider state once and rejects any superseded response after hide/unmount. */
  async function reveal() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await controls.read(distributionId, controller.signal);
      if (!controller.signal.aborted) setInfo(result);
    } catch {
      if (!controller.signal.aborted)
        setError(
          t("Could not retrieve broadcast details. Reconnect the Channel or refresh the Post."),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  /** Ends only this confirmed broadcast, clears credentials, and retains the confirmation on failure. */
  async function end() {
    setError(null);
    try {
      await controls.end.mutateAsync(distributionId);
      pending.current?.abort();
      setInfo(null);
      setConfirmEnd(false);
    } catch {
      setError(
        t(
          "The end request could not be confirmed. Refresh the broadcast state before trying again.",
        ),
      );
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-control border border-line p-3">
      <h4 className="text-xs font-semibold text-ink">{t("Live broadcast")}</h4>
      <p className="text-xs text-ink-3">
        {t(
          "Use these credentials in your external encoder. Treat the stream URL and key as secrets; anyone holding them can broadcast to this Channel.",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void reveal()}>
          {busy
            ? t("Loading…")
            : info
              ? t("Refresh broadcast state")
              : t("Show encoder credentials")}
        </Button>
        {(info || busy) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              pending.current?.abort();
              setInfo(null);
              setBusy(false);
            }}
          >
            {t("Hide credentials")}
          </Button>
        )}
      </div>
      {info && (
        <>
          <p className="text-xs text-ink-2">
            {
              {
                ready: t("Ready for encoder"),
                testing: t("Testing stream"),
                live: t("Streaming live"),
                ended: t("Broadcast ended"),
              }[info.state]
            }
          </p>
          {(["ingestUrl", "streamKey"] as const).map(
            (field) =>
              info[field] && (
                <label key={field} className="flex min-w-0 flex-col gap-1 text-xs text-ink-3">
                  {field === "ingestUrl" ? t("RTMPS ingest URL") : t("Stream key")}
                  <div className="flex min-w-0 gap-2">
                    <Input type="password" readOnly autoComplete="off" value={info[field]} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void copyText(info[field] ?? "").catch(() =>
                          setError(
                            t(
                              "Clipboard access was denied. Select and copy the credential manually.",
                            ),
                          ),
                        );
                      }}
                    >
                      {t("Copy")}
                    </Button>
                  </div>
                </label>
              ),
          )}
        </>
      )}
      {info?.state !== "ended" && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setConfirmEnd(true)}
        >
          {t("End broadcast")}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-red">
          {error}
        </p>
      )}
      <CenterAlertDialog
        open={confirmEnd}
        onOpenChange={(open) => !controls.end.isPending && setConfirmEnd(open)}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("End this broadcast?")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "This stops the current live broadcast. Your encoder cannot restart the ended broadcast with the same credentials.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel disabled={controls.end.isPending}>
              {t("Keep streaming")}
            </CenterAlertDialogCancel>
            <CenterAlertDialogAction
              disabled={controls.end.isPending}
              onClick={(event) => {
                event.preventDefault();
                void end();
              }}
            >
              {controls.end.isPending ? t("Ending…") : t("End broadcast")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>
    </section>
  );
}
