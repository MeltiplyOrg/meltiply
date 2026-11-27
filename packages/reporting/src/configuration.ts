import { isLoopbackHostname } from "@meltiply/domain";

import type { DeploymentCategory } from "./contracts";

export interface ReportingConfiguration {
  readonly deploymentCategory: DeploymentCategory;
  readonly destination: ReportingDestination | null;
  readonly forcedOff: boolean;
}

export interface ReportingDestination {
  readonly captureUrl: string;
  readonly projectToken: string;
}

export interface ReportingBindingValues {
  readonly DEPLOYMENT_CATEGORY?: string;
  readonly REPORTING_FORCED_OFF?: string;
  readonly REPORTING_POSTHOG_HOST?: string;
  readonly REPORTING_POSTHOG_PROJECT_TOKEN?: string;
  readonly VERSION?: string;
}

const capturePath = "/i/v0/e/";

const projectTokenPattern = /^phc_[A-Za-z0-9_-]{8,200}$/;

function deploymentCategory(value: string | undefined): DeploymentCategory {
  if (value?.trim() === "managed") return "managed";
  if (value?.trim() === "selfhosted") return "selfhosted";
  return "unknown";
}

function reportingDestination(
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
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) return null;
  return { captureUrl: `${url.origin}${capturePath}`, projectToken: token };
}

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

export function reportedAppVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 40) return "unknown";
  return /^[A-Za-z0-9.+_-]+$/.test(trimmed) ? trimmed : "unknown";
}
