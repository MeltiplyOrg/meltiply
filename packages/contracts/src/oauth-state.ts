import type { components } from "./generated/schema";

export type OAuthSelectionAccount = components["schemas"]["OAuthSelectionAccount"];
export type OAuthSelectionPublic = components["schemas"]["OAuthSelection"];
export type Platform = components["schemas"]["Platform"];

export interface OAuthStateRecord {
  expires_at: number;
  organization_id: string;
  pkce_verifier?: string;
  provider: string;
  redirect_path: string;
  user_id: string;
}

/** Stored in its own entry so candidate payloads stay under the SQLite 2 MB DO value limit. */
export interface OAuthSelectionCandidate {
  readonly account: OAuthSelectionAccount;
  readonly encryptedConnection: string;
}

export interface OAuthSelectionInit {
  readonly expires_at: number;
  readonly id: string;
  readonly organization_id: string;
  readonly platform: string;
  readonly user_id: string;
}

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
      readonly code:
        | "already_completed"
        | "pinned_account_mismatch"
        | "pinned_profile_mismatch"
        | "claim_active";
      readonly message: string;
      readonly status: "conflict";
    }
  | {
      readonly message: string;
      readonly status: "invalid_account";
    };

export type CancelSelectionResult =
  | { readonly status: "cancelled" }
  | { readonly status: "not_found" }
  | { readonly message: string; readonly status: "conflict" };

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
    actor: { brandProfileId: string; organizationId: string; userId: string },
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
