import type { components } from "@meltiply/contracts/schema";
import type { DatabaseError } from "@meltiply/domain";
import type { Effect } from "effect";

import type { PreferenceRow } from "../publishing-preferences-rules";
import type { TenantRepositoryProvider, TenantTransaction } from "./tenant-repository";

type Schemas = components["schemas"];

export interface SavedPreferences {
  notifications: Schemas["NotificationPreferences"];
  signatures: Schemas["SignatureTemplate"][];
  timezone: string | null;
}

export interface PublishingPreferencesQueries {
  preferences(): Effect.Effect<PreferenceRow | undefined, DatabaseError>;
  savePreferences(
    organizationId: string,
    preferences: SavedPreferences,
  ): Effect.Effect<PreferenceRow | undefined, DatabaseError>;
}

export type PublishingPreferencesTransaction = TenantTransaction & PublishingPreferencesQueries;

export type PublishingPreferencesRepositoryProvider =
  TenantRepositoryProvider<PublishingPreferencesTransaction>;
