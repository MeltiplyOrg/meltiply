import type { SessionClaims } from "@meltiply/auth";
import { Effect } from "effect";

import type { PreferenceRow } from "../publishing-preferences-rules";
import {
  FakeTenantRepository,
  FakeTenantStore,
  FakeTenantTransaction,
} from "./fake-tenant-repository";
import type {
  PublishingPreferencesTransaction,
  SavedPreferences,
} from "./publishing-preferences-repository";

export class FakePublishingPreferencesStore extends FakeTenantStore {
  readonly preferences = new Map<string, PreferenceRow>();

  constructor(readonly now: () => Date) {
    super();
  }
}

class FakePublishingPreferencesTransaction
  extends FakeTenantTransaction
  implements PublishingPreferencesTransaction
{
  constructor(
    private readonly store: FakePublishingPreferencesStore,
    session: SessionClaims,
  ) {
    super(store, session);
  }

  preferences() {
    return Effect.sync(() => {
      const organizationId = this.member?.organizationId;
      const row = organizationId ? this.store.preferences.get(organizationId) : undefined;
      return row ? structuredClone(row) : undefined;
    });
  }

  savePreferences(organizationId: string, preferences: SavedPreferences) {
    return Effect.sync(() => {
      const previous = this.store.preferences.get(organizationId);
      const row: PreferenceRow = {
        notification_preferences: structuredClone(preferences.notifications),
        signature_templates: structuredClone(preferences.signatures),
        timezone: preferences.timezone,
        updated_at: this.store.now(),
      };
      this.store.preferences.set(organizationId, row);
      this.onRollback(() => {
        if (previous) this.store.preferences.set(organizationId, previous);
        else this.store.preferences.delete(organizationId);
      });
      return structuredClone(row);
    });
  }
}

export class FakePublishingPreferencesRepository extends FakeTenantRepository<FakePublishingPreferencesTransaction> {
  constructor(readonly store: FakePublishingPreferencesStore) {
    super((session) => new FakePublishingPreferencesTransaction(store, session));
  }
}
