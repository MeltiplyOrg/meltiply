import type { DeploymentCategory } from "./contracts";

/**
 * Deployment-side reporting configuration.
 *
 * The maintainer provisions one PostHog Cloud project and ships its publishable
 * project token plus the matching ingestion host through the supported
 * deployment artifacts, so a self-hoster never needs their own PostHog account.
 * Ingestion needs no personal API key.
 *
 * Every field is untrusted deployment input. An unusable destination disables
 * optional reporting while the product keeps working; it never throws during
 * request handling.
 */
export interface ReportingConfiguration {
  /** Deployment category reported alongside each event. */
  readonly deploymentCategory: DeploymentCategory;
  /** `null` when the destination is missing or unusable. */
  readonly destination: ReportingDestination | null;
  /** Operator force-off override, which outranks any saved preference. */
  readonly forcedOff: boolean;
}

/** Validated capture endpoint derived from the operator's token and host. */
export interface ReportingDestination {
  /** Absolute capture URL, always `{host}/i/v0/e/`. */
  readonly captureUrl: string;
  /** Publishable project token sent as `api_key`. */
  readonly projectToken: string;
}

/** Raw deployment bindings as the workers receive them. */
export interface ReportingBindingValues {
  readonly DEPLOYMENT_CATEGORY?: string;
  readonly REPORTING_FORCED_OFF?: string;
  readonly REPORTING_POSTHOG_HOST?: string;
  readonly REPORTING_POSTHOG_PROJECT_TOKEN?: string;
  readonly VERSION?: string;
}

/**
 * Ingestion path PostHog Cloud documents for a single event.
 *
 * The capture reference at https://posthog.com/docs/api/capture names
 * `/i/v0/e/` (with `/batch/` as the multi-event sibling) and takes the
 * publishable project token, event name, `distinct_id` and `properties`.
 */
const capturePath = "/i/v0/e/";

/** Publishable project tokens are `phc_`-prefixed, url-safe and bounded. */
const projectTokenPattern = /^phc_[A-Za-z0-9_-]{8,200}$/;

/** Deployment labels collapse to a coarse category; anything else is `unknown`. */
function deploymentCategory(value: string | undefined): DeploymentCategory {
  if (value?.trim() === "managed") return "managed";
  if (value?.trim() === "selfhosted") return "selfhosted";
  return "unknown";
}

/**
 * Validates the configured ingestion host and derives the capture endpoint.
 *
 * The host must be a canonical HTTPS origin: no credentials, path, query or
 * fragment. Plain HTTP stays available only for loopback hosts, so a local
 * acceptance stack can point at a controlled receiver without weakening a
 * deployed installation. A trailing slash is tolerated because operators copy
 * the origin from the PostHog project settings page.
 *
 * @param value - Configured host, e.g. `https://us.i.posthog.com`.
 * @returns The destination, or null when the host is unusable.
 */
export function reportingDestination(
  value: string | undefined,
  projectToken: string | undefined,
): ReportingDestination | null {
  const token = projectToken?.trim();
  if (!token || !projectTokenPattern.test(token)) return null;
  const configured = value?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) return null;
  return { captureUrl: `${url.origin}${capturePath}`, projectToken: token };
}

/**
 * Resolves the deployment's reporting configuration from raw bindings.
 *
 * Absent or malformed bindings are configuration, not failures: the resulting
 * configuration reports no destination and the policy layer then fails closed
 * for both categories.
 *
 * @param bindings - Raw Worker environment bindings.
 * @returns Usable configuration with a validated destination or a disabled one.
 */
export function reportingConfiguration(bindings: ReportingBindingValues): ReportingConfiguration {
  return {
    deploymentCategory: deploymentCategory(bindings.DEPLOYMENT_CATEGORY),
    destination: reportingDestination(
      bindings.REPORTING_POSTHOG_HOST,
      bindings.REPORTING_POSTHOG_PROJECT_TOKEN,
    ),
    forcedOff: bindings.REPORTING_FORCED_OFF?.trim().toLowerCase() === "true",
  };
}

/** The application version reported with each event, bounded and sanitized. */
export function reportedAppVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 40) return "unknown";
  return /^[A-Za-z0-9.+_-]+$/.test(trimmed) ? trimmed : "unknown";
}
