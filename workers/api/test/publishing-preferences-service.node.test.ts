import type { SessionClaims } from "@meltiply/auth";
import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import { createPublishingPreferencesApiService } from "../src/publishing-preferences-service";
import {
  FakePublishingPreferencesRepository,
  FakePublishingPreferencesStore,
} from "../src/repositories/fake-publishing-preferences-repository";
import { fakeEnv } from "../test-support/fakes";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const ORG = "org-1";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mail: SendEmail = { send: () => Promise.resolve({ messageId: "sent" }) };
const env = fakeEnv();
const mailEnv = fakeEnv({ MAIL: mail, MAIL_FROM_ADDRESS: "notifications@meltiply.test" });

const claims = (subject: string): SessionClaims => ({
  organizationId: ORG,
  organizationRole: subject,
  subject,
  userId: subject,
});
const admin = claims("admin");

const quiet = {
  channels: { email: { enabled: false, recipients: [] as string[] } },
  events: { channel_disconnected: false, publication_failed: false },
};
const update = {
  notifications: {
    ...quiet,
    channels: { email: { enabled: false, recipients: [" A@Example.com ", "a@example.com"] } },
  },
  signature_templates: [
    { body: " From {channel} ", id: A, is_default: true, name: " Main ", position: 3 },
  ],
  timezone: "Europe/Paris",
};
const normalizedNotifications = {
  ...quiet,
  channels: { email: { enabled: false, recipients: ["a@example.com"] } },
};
const stored = {
  notification_preferences: normalizedNotifications,
  signature_templates: [
    { body: "From {channel}", id: A, is_default: true, name: "Main", position: 0 },
  ],
  timezone: "Europe/Paris",
  updated_at: NOW,
};
const saved = {
  email_available: false,
  notifications: normalizedNotifications,
  signature_templates: stored.signature_templates,
  timezone: "Europe/Paris",
  updated_at: NOW.toISOString(),
};
const untouched = {
  email_available: false,
  notifications: quiet,
  signature_templates: [],
  timezone: null,
  updated_at: "1970-01-01T00:00:00.000Z",
};
const down = new DatabaseError({ message: "database down" });

function setup() {
  const store = new FakePublishingPreferencesStore(() => NOW);
  store.members.push(
    { organizationId: ORG, role: "admin", subject: "admin" },
    { organizationId: ORG, role: "editor", subject: "editor" },
  );
  const service = createPublishingPreferencesApiService({
    repository: () => new FakePublishingPreferencesRepository(store),
  });
  return { service, store };
}

const run = <Value, Failure>(program: Effect.Effect<Value, Failure>) => Effect.runPromise(program);
const failure = <Value, Failure>(program: Effect.Effect<Value, Failure>) =>
  Effect.runPromise(Effect.flip(program));

describe("PublishingPreferencesService", () => {
  describe("get", () => {
    it("nothing stored, without mail", async () => {
      const { service } = setup();

      expect(await run(service.get(env, claims("editor")))).toEqual(untouched);
    });

    it("stored preferences, with mail", async () => {
      const { service, store } = setup();
      store.preferences.set(ORG, stored);

      expect(await run(service.get(mailEnv, admin))).toEqual({ ...saved, email_available: true });
    });
  });

  describe("replace", () => {
    it("a document to normalize", async () => {
      const { service, store } = setup();

      const result = await run(service.replace(env, admin, update, "key-1"));

      expect(result).toEqual({ replayed: false, value: saved });
      expect([...store.preferences]).toEqual([[ORG, stored]]);
      expect([...store.idempotencyKeys.values()]).toEqual([
        {
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          response_body: saved,
          response_status: 200,
        },
      ]);
    });

    it("no timezone", async () => {
      const { service, store } = setup();

      await run(service.replace(env, admin, { ...update, timezone: null }, "key-1"));

      expect(store.preferences.get(ORG)).toEqual({ ...stored, timezone: null });
    });

    it("email enabled on an installation with mail", async () => {
      const { service } = setup();
      const notifications = {
        ...quiet,
        channels: { email: { enabled: true, recipients: ["ops@example.com"] } },
      };

      const result = await run(
        service.replace(mailEnv, admin, { ...update, notifications }, "key-1"),
      );

      expect(result.value).toEqual({ ...saved, email_available: true, notifications });
    });

    it("email enabled on an installation without mail", async () => {
      const { service, store } = setup();
      const notifications = {
        ...quiet,
        channels: { email: { enabled: true, recipients: ["ops@example.com"] } },
      };

      const error = await failure(
        service.replace(env, admin, { ...update, notifications }, "key-1"),
      );

      expect(error).toEqual(
        new CoreApiError(
          422,
          "notification_channel_unavailable",
          "Email delivery is not configured for this installation.",
        ),
      );
      expect(store.preferences.size).toEqual(0);
    });

    it("an unsupported timezone", async () => {
      const { service, store } = setup();

      const error = await failure(
        service.replace(env, admin, { ...update, timezone: "Not/AZone" }, "key-1"),
      );

      expect(error).toEqual(
        new CoreApiError(422, "validation_error", "Use a supported IANA timezone."),
      );
      expect(store.idempotencyKeys.size).toEqual(0);
    });

    it("an Editor", async () => {
      const { service, store } = setup();

      const error = await failure(service.replace(env, claims("editor"), update, "key-1"));

      expect(error).toEqual(
        new CoreApiError(
          403,
          "workspace_admin_required",
          "Only Workspace Admins can change publishing preferences.",
        ),
      );
      expect(store.preferences.size).toEqual(0);
    });

    it("someone outside the Workspace", async () => {
      const { service } = setup();

      const error = await failure(service.replace(env, claims("stranger"), update, "key-1"));

      expect(error).toEqual(
        new ActiveOrganizationRequiredError({
          message: "The authenticated identity is not an active organization member.",
        }),
      );
    });

    it("the same request twice", async () => {
      const { service } = setup();
      await run(service.replace(env, admin, update, "key-1"));

      const result = await run(service.replace(env, admin, update, "key-1"));

      expect(result).toEqual({ replayed: true, value: saved });
    });

    it("a key reused for another document", async () => {
      const { service } = setup();
      await run(service.replace(env, admin, update, "key-1"));

      const error = await failure(
        service.replace(env, admin, { ...update, timezone: null }, "key-1"),
      );

      expect(error).toEqual(
        new CoreApiError(
          409,
          "idempotency_conflict",
          "The Idempotency-Key was already used with a different request.",
        ),
      );
    });

    it("the database fails at commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);

      expect(await failure(service.replace(env, admin, update, "key-1"))).toEqual(down);
      expect(store.preferences.size).toEqual(0);
    });

    it("a retry after a failed commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);
      await failure(service.replace(env, admin, update, "key-1"));

      const result = await run(service.replace(env, admin, update, "key-1"));

      expect(result).toEqual({ replayed: false, value: saved });
    });
  });
});
