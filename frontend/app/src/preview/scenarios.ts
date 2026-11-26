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
  operationId?: string;
  responseStatus?: number;
}

export function isPreviewScenario(value: string | null): value is PreviewScenario {
  return previewScenarios.some((scenario) => scenario === value);
}

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

export const activePreviewOptions: PreviewOptions = globalThis.location
  ? previewOptionsFromUrl(new URL(globalThis.location.href))
  : { scenario: "populated" };
