export const previewScenarios = [
  "populated",
  "empty",
  "loading",
  "success",
  "validation-error",
  "server-error",
  "signed-out",
  "permission-denied",
  "publication-failed",
  "channel-expired",
  "viewer",
  "editor",
  "first-run",
  "two-factor",
] as const;
export type PreviewScenario = (typeof previewScenarios)[number];
export interface PreviewOptions {
  scenario?: PreviewScenario;
  /** Scope outcomes to an operation; unset applies to feature reads/mutations without breaking session/workspace bootstrap. */
  operationId?: string;
  /** Select an exact documented response for the scoped operation. */
  responseStatus?: number;
}

/** Validates a stable developer scenario identifier supplied through the URL or preview controls. */
export function isPreviewScenario(value: string | null): value is PreviewScenario {
  return previewScenarios.some((scenario) => scenario === value);
}

/** Reads shareable preview-only options without persisting records or changing production configuration. Unknown values use the populated scenario. */
function previewOptionsFromUrl(url: URL): PreviewOptions {
  const value = url.searchParams.get("previewScenario");
  const operationId = url.searchParams.get("previewOperation");
  const responseStatus = Number(url.searchParams.get("previewStatus"));
  return {
    scenario: isPreviewScenario(value) ? value : "populated",
    ...(operationId ? { operationId } : {}),
    ...(Number.isInteger(responseStatus) && responseStatus >= 200 && responseStatus <= 599
      ? { responseStatus }
      : {}),
  };
}

/** Captures the selected scenario before auth/router redirects can drop query parameters. Switching controls reloads the page and resets all browser data. */
export const activePreviewOptions: PreviewOptions = globalThis.location
  ? previewOptionsFromUrl(new URL(globalThis.location.href))
  : { scenario: "populated" };
