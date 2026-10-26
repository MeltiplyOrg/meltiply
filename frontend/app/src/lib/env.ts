const localApiBaseUrl = "http://localhost:8787";

/**
 * Validates and normalizes the public backend API base URL.
 * An unset or empty value resolves to the same-origin default: the frontend
 * Worker proxies `/api/*` to the API Worker via service binding, so browser
 * sessions use the page origin and the Better Auth cookie flows without CORS.
 * Non-browser contexts (Vitest, tooling) have no `location` and fall back to
 * the local Wrangler dev API origin. Configured values must be well-formed
 * http/https origins without path/query/hash; trailing slashes are stripped.
 *
 * @param value Raw environment value to validate.
 * @returns Normalized URL string with trailing slashes stripped.
 * @throws {Error} If the URL is malformed, has an invalid scheme, or includes path/query/hash components.
 */
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
  return raw.replace(/\/+$/, "");
}

/**
 * Environment source shape for the development-mode accessor.
 */
export type DevModeSource = {
  DEV?: boolean | undefined;
};

export type PublicEnv = {
  APP_URL: string;
};
export type PublicEnvSource = Partial<Record<keyof PublicEnv, string | undefined>>;

/**
 * Resolves and validates public frontend environment variables.
 * Normalizes `APP_URL` by stripping trailing slashes and ensuring no extraneous
 * query parameters or hash fragments are present; unset resolves to the same-origin default.
 *
 * @param source Optional dictionary of environment variable overrides; defaults to `import.meta.env`.
 * @returns Validated `PublicEnv` object containing normalized `APP_URL`.
 * @throws {Error} When `APP_URL` fails validation or is malformed.
 */
export function getPublicEnv(source?: PublicEnvSource): PublicEnv {
  const rawValue = source === undefined ? import.meta.env.APP_URL : source.APP_URL;
  return {
    APP_URL: validateAndNormalizeApiBaseUrl(rawValue),
  };
}

/**
 * Resolves the configured API base URL string from public environment variables.
 * Lives beside `getPublicEnv` (not in `lib/api.ts`) so cookie-session callers such
 * as `lib/auth-client.ts` can resolve the origin without importing the Effect
 * query layer — keeping the unauthenticated runtime's module graph small.
 *
 * @param source Optional environment variable source overrides.
 * @returns API base URL string without trailing slash.
 */
export function getApiBaseUrl(source?: PublicEnvSource): string {
  return getPublicEnv(source).APP_URL;
}

/**
 * Reports whether the frontend bundle is running in Vite development mode.
 * Gates dev-only tooling (e.g. the Agentation inspector) behind a single
 * environment accessor instead of scattered `import.meta.env.DEV` reads.
 *
 * @param source Optional override dictionary; defaults to `import.meta.env`.
 * @returns `true` when the app runs in development mode.
 */
export function isDevMode(source?: DevModeSource): boolean {
  return (source === undefined ? import.meta.env.DEV : source.DEV) === true;
}

/** Identifies the dedicated synthetic UI build; runtime URLs and user input cannot enable this mode. */
export function isUiPreview(): boolean {
  return import.meta.env.MODE === "ui-preview";
}
