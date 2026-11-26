import type { EffectTransactionClient } from "@meltiply/database";
import { Effect } from "effect";

import type { PreferenceRow } from "../publishing-preferences-rules";
import { postgresTenantRepository } from "./postgres-tenant-repository";
import type { PublishingPreferencesQueries } from "./publishing-preferences-repository";

function publishingPreferencesQueries(
  client: EffectTransactionClient,
): PublishingPreferencesQueries {
  return {
    preferences: () =>
      client
        .query<PreferenceRow>(
          `SELECT timezone, signature_templates, notification_preferences, updated_at
               FROM publishing_preferences WHERE org_id = public.auth_active_org_id()`,
        )
        .pipe(Effect.map((result) => result.rows[0])),
    savePreferences: (organizationId, preferences) =>
      client
        .query<PreferenceRow>(
          `INSERT INTO publishing_preferences
                       (org_id, timezone, signature_templates, notification_preferences)
                     VALUES ($1, $2, $3::jsonb, $4::jsonb)
                     ON CONFLICT (org_id) DO UPDATE SET
                       timezone = EXCLUDED.timezone,
                       signature_templates = EXCLUDED.signature_templates,
                       notification_preferences = EXCLUDED.notification_preferences,
                       updated_at = now()
                     RETURNING timezone, signature_templates, notification_preferences, updated_at`,
          [
            organizationId,
            preferences.timezone,
            JSON.stringify(preferences.signatures),
            JSON.stringify(preferences.notifications),
          ],
        )
        .pipe(Effect.map((result) => result.rows[0])),
  };
}

export const postgresPublishingPreferencesRepository = postgresTenantRepository(
  publishingPreferencesQueries,
);
