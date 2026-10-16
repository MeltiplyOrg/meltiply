import type { components } from "./generated/schema";

export { apiVersionPath, createMeltiplyClient, type MeltiplyClient } from "./client";
export type { components, operations, paths } from "./generated/schema";

/** Public capability contract shared by API, provider, and frontend callers. */
export type PlatformCapability = components["schemas"]["PlatformCapability"];

/** A stable, typed explanation of one rejected publish constraint. */
export interface ValidationIssue {
  actual?: number;
  constraint: string;
  field: string;
  limit?: number;
  message: string;
}

export * from "./oauth-state";
