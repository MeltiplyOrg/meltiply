import { useState } from "react";
import { Schema } from "effect";
import { Button } from "@meltiply/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import contract from "virtual:preview-contract";
import { useI18n } from "@/lib/i18n";
import { activePreviewOptions, isPreviewScenario, previewScenarios } from "./scenarios";

const selection = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, platform: Schema.String }),
)(contract.fixtures.oauth_selection);

/** Owns the DevBox Preview tab's scenario, operation, response, and route controls. Apply reloads with shareable URL options and fresh browser data; no backend or production state changes. */
export function PreviewControls() {
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
    <section aria-label={t("Preview controls")} className="grid gap-4">
      <p className="text-xs text-ink-3">
        {t("UI preview · Synthetic data · Refresh resets changes")}
      </p>
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
            <SelectContent className="z-(--z-devbox-overlay)">
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
            <SelectContent className="z-(--z-devbox-overlay)">
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
            <SelectContent className="z-(--z-devbox-overlay)">
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
            <SelectContent className="z-(--z-devbox-overlay)">
              {contract.routes.map((value) => (
                <SelectItem key={value} value={value}>
                  <code>{value}</code>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => apply(true)}>
          {t("Reset preview")}
        </Button>
        <Button onClick={() => apply()}>{t("Apply preview")}</Button>
      </div>
    </section>
  );
}
