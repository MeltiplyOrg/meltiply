import { useState } from "react";
import { Schema } from "effect";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogFooter,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogTrigger,
} from "@meltiply/ui/center-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import contract from "virtual:preview-contract";
import { useI18n } from "@/lib/i18n";
import { activePreviewOptions, isPreviewScenario, previewScenarios } from "./scenarios";

const selection = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, platform: Schema.String }),
)(contract.fixtures.oauth_selection);

/** Owns preview-only scenario/operation/response/route selection using canonical controls. Apply reloads the real route with shareable URL options and fresh local data; it never changes production or backend state. */
export function PreviewNotice() {
  const { t } = useI18n();
  const [scenario, setScenario] = useState(activePreviewOptions.scenario ?? "populated");
  const [operationId, setOperationId] = useState(activePreviewOptions.operationId ?? "*");
  const [status, setStatus] = useState(String(activePreviewOptions.responseStatus ?? "default"));
  const [route, setRoute] = useState(() => window.location.pathname);
  const operation = contract.operations.find((entry) => entry.operationId === operationId);
  const statuses = [
    "default",
    ...(operation?.responses.map((response) => String(response.status)) ?? []),
  ];

  /** Applies only explicit developer options, preserving feature query parameters and supplying synthetic credentials for standalone handoff routes. */
  const apply = (reset = false) => {
    const url = new URL(window.location.href);
    url.pathname = route;
    for (const key of ["previewScenario", "previewOperation", "previewStatus"])
      url.searchParams.delete(key);
    if (!reset) {
      url.searchParams.set(
        "previewScenario",
        route === "/sign-in" && ["populated", "success"].includes(scenario)
          ? "signed-out"
          : scenario,
      );
      if (operationId !== "*") url.searchParams.set("previewOperation", operationId);
      if (operationId !== "*" && status !== "default")
        url.searchParams.set("previewStatus", status);
    }
    if (route === "/channels/connect") {
      url.searchParams.set("selection_id", selection.id);
      url.searchParams.set("provider", selection.platform);
    }
    if (route === "/invitations/accept") url.searchParams.set("token", "preview-invitation");
    window.location.assign(url.href);
  };

  return (
    <CenterDialog>
      <div className="pointer-events-none fixed inset-x-3 bottom-16 z-50 flex justify-center sm:bottom-3">
        <Alert
          role="status"
          variant="info"
          className="pointer-events-auto w-auto max-w-full flex-wrap items-center px-3 py-2 text-xs shadow-card"
        >
          <span>{t("UI preview · Synthetic data · Refresh resets changes")}</span>
          <CenterDialogTrigger asChild>
            <Button variant="outline" size="sm">
              {t("Preview controls")}
            </Button>
          </CenterDialogTrigger>
        </Alert>
      </div>
      <CenterDialogContent>
        <CenterDialogHeader>
          <CenterDialogTitle>{t("Preview controls")}</CenterDialogTitle>
          <CenterDialogDescription>
            {t("UI preview · Synthetic data · Refresh resets changes")}
          </CenterDialogDescription>
        </CenterDialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-ink">{t("Preview scenario")}</span>
            <Select
              value={scenario}
              onValueChange={(value) => {
                if (isPreviewScenario(value)) setScenario(value);
              }}
            >
              <SelectTrigger aria-label={t("Preview scenario")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {previewScenarios.map((value) => (
                  <SelectItem key={value} value={value}>
                    <code>{value}</code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-ink">{t("Preview operation")}</span>
            <Select
              value={operationId}
              onValueChange={(value) => {
                setOperationId(value);
                setStatus("default");
              }}
            >
              <SelectTrigger aria-label={t("Preview operation")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="*">*</SelectItem>
                {contract.operations.map((entry) => (
                  <SelectItem key={entry.operationId} value={entry.operationId}>
                    <code>
                      {entry.method.toUpperCase()} {entry.operationId}
                    </code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-ink">{t("Preview response")}</span>
            <Select value={status} onValueChange={setStatus} disabled={!operation}>
              <SelectTrigger aria-label={t("Preview response")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((value) => (
                  <SelectItem key={value} value={value}>
                    <code>{value}</code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-ink">{t("Preview route")}</span>
            <Select value={route} onValueChange={setRoute}>
              <SelectTrigger aria-label={t("Preview route")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {contract.routes.map((value) => (
                  <SelectItem key={value} value={value}>
                    <code>{value}</code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CenterDialogFooter>
          <Button variant="outline" onClick={() => apply(true)}>
            {t("Reset preview")}
          </Button>
          <Button onClick={() => apply()}>{t("Apply preview")}</Button>
        </CenterDialogFooter>
      </CenterDialogContent>
    </CenterDialog>
  );
}
