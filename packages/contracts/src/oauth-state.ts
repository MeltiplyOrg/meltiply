import type { components } from "./generated/schema";

export type OAuthSelectionAccount = components["schemas"]["OAuthSelectionAccount"];
export type OAuthSelectionPublic = components["schemas"]["OAuthSelection"];
export type Platform = components["schemas"]["Platform"];

/**
 * Context persisted for an initial OAuth authorization handoff.
 */
export interface OAuthStateRecord {
  expires_at: number;
  organization_id: string;
  pkce_verifier?: string;
  provider: string;
  redirect_path: string;
  user_id: string;
}

/**
 * One discovered candidate account containing both sanitized metadata and sealed credential.
 * Stored in its own bounded storage entry to avoid exceeding SQLite 2MB limits.
 */
export interface OAuthSelectionCandidate {
  readonly account: OAuthSelectionAccount;
  readonly encryptedConnection: string;
}

/**
 * Initial metadata supplied when initiating a pending OAuth assignment session.
 */
export interface OAuthSelectionInit {
  readonly expires_at: number;
  readonly id: string;
  readonly organization_id: string;
  readonly platform: string;
  readonly user_id: string;
}

/**
 * Master lifecycle record for a pending OAuth account assignment.
 * Stores bounded metadata, account IDs, and lifecycle state only.
 */
export interface OAuthSelectionRecord {
  readonly account_ids: ReadonlyArray<string>;
  claim?: {
    readonly claimed_at: number;
    readonly expires_at: number;
    readonly idempotency_key: string;
    readonly token: string;
  };
  completed_account_id?: string;
  completed_idempotency_key?: string;
  cancelled_idempotency_key?: string;
  /**
   * Bounded retention deadline for secret-free fence/replay evidence.
   * Set when the credential sweep strips an expired ticket; the master record
   * is deleted once this passes. Unset means expires_at + retention applies.
   */
  evidence_expires_at?: number;
  expires_at: number;
  readonly id: string;
  readonly organization_id: string;
  pinned_account_id?: string;
  readonly platform: string;
  ready: boolean;
  status: "pending" | "completed" | "cancelled";
  readonly user_id: string;
}

/**
 * Result of claiming an OAuth candidate account for persistence.
 */
export type ClaimSelectionResult =
  | {
      readonly claimToken: string;
      readonly encryptedConnection: string;
      readonly organizationId: string;
      readonly platform: string;
      readonly status: "claimed";
      readonly userId: string;
    }
  | {
      readonly status: "replayed";
    }
  | {
      readonly status: "not_found";
    }
  | {
      readonly code: "already_completed" | "pinned_account_mismatch" | "claim_active";
      readonly message: string;
      readonly status: "conflict";
    }
  | {
      readonly message: string;
      readonly status: "invalid_account";
    };

/**
 * Result of discarding or cancelling an in-flight OAuth selection.
 */
export type CancelSelectionResult =
  | { readonly status: "cancelled" }
  | { readonly status: "not_found" }
  | { readonly message: string; readonly status: "conflict" };

/**
 * RPC contract for the OAuthStateCoordinator Durable Object (meltiply-state).
 */
export interface OAuthStateCoordinatorStub {
  create(state: string, record: OAuthStateRecord): Promise<void>;
  consume(state: string): Promise<OAuthStateRecord | null>;
  createSelection(selectionId: string, init: OAuthSelectionInit): Promise<void>;
  appendSelectionCandidates(
    selectionId: string,
    candidates: ReadonlyArray<OAuthSelectionCandidate>,
  ): Promise<void>;
  finalizeSelection(selectionId: string): Promise<void>;
  getSelection(
    selectionId: string,
    actor: { organizationId: string; userId: string },
  ): Promise<OAuthSelectionPublic | null>;
  claimSelection(
    selectionId: string,
    accountId: string,
    actor: { organizationId: string; userId: string },
    idempotencyKey: string,
    leaseMs?: number,
  ): Promise<ClaimSelectionResult>;
  completeSelection(
    selectionId: string,
    accountId: string,
    claimToken: string,
    idempotencyKey: string,
  ): Promise<boolean>;
  releaseSelectionClaim(selectionId: string, claimToken: string): Promise<boolean>;
  cancelSelection(
    selectionId: string,
    actor: { organizationId: string; userId: string },
    idempotencyKey: string,
  ): Promise<CancelSelectionResult>;
}
