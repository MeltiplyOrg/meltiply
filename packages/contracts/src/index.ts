import type { components } from "./generated/schema";

export { apiVersionPath, createMeltiplyClient, type MeltiplyClient } from "./client";
export type { components, operations, paths } from "./generated/schema";
export { CONTRACT_VERSION } from "./generated/version";

/** Public capability contract shared by API, provider, and frontend callers. */
export type PlatformCapability = components["schemas"]["PlatformCapability"];

/** A stable, typed explanation of one rejected publish constraint, derived from OpenAPI. */
export type ValidationIssue = components["schemas"]["ValidationIssue"];

export type {
  CancelSelectionResult,
  ClaimSelectionResult,
  OAuthSelectionAccount,
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthSelectionPublic,
  OAuthSelectionRecord,
  OAuthStateCoordinatorStub,
  OAuthStateRecord,
  Platform,
} from "./oauth-state";
