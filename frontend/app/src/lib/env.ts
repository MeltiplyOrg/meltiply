const trailingSlashesPattern = /\/+$/;

const localApiBaseUrl = "http://localhost:8787";

function validateAndNormalizeApiBaseUrl(value: unknown): string {
  const raw =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : (globalThis.location?.origin ?? localApiBaseUrl);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid public environment: APP_URL must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid public environment: APP_URL must be a valid URL");
  }
  return raw.replace(trailingSlashesPattern, "");
}

export type DevModeSource = {
  DEV?: boolean | undefined;
  MODE?: string | undefined;
};

export type PublicEnv = {
  APP_URL: string;
};
export type PublicEnvSource = Partial<Record<keyof PublicEnv, string | undefined>>;

export function getPublicEnv(source?: PublicEnvSource): PublicEnv {
  const rawValue = source === undefined ? import.meta.env.APP_URL : source.APP_URL;
  return {
    APP_URL: validateAndNormalizeApiBaseUrl(rawValue),
  };
}

export function getApiBaseUrl(): string {
  return getPublicEnv().APP_URL;
}

export function isDevMode(source?: DevModeSource): boolean {
  const environment = source ?? import.meta.env;
  return environment.DEV === true || environment.MODE === "ui-preview";
}

export function isUiPreview(): boolean {
  return import.meta.env.MODE === "ui-preview";
}
