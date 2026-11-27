import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import {
  emailDeliveryAvailable,
  mapPreferences,
  normalizeNotificationRecipients,
  normalizeSignatureTemplates,
  preferencesError,
  validatedPreferences,
  validateNotifications,
} from "../src/publishing-preferences-rules";
import { fakeEnv } from "../test-support/fakes";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mail: SendEmail = { send: () => Promise.resolve({ messageId: "sent" }) };

const invalid = (message: string) => new CoreApiError(422, "validation_error", message);
const template = { body: "Thanks", id: A, is_default: true, name: "Main", position: 0 };
const quiet = {
  channels: { email: { enabled: false, recipients: [] as string[] } },
  events: { channel_disconnected: false, publication_failed: false },
};
const emailing = (enabled: boolean, recipients: string[]) => ({
  channels: { email: { enabled, recipients } },
  events: { channel_disconnected: true, publication_failed: false },
});

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("emailDeliveryAvailable", () => {
  it.each([
    ["a mail binding and a sender", { MAIL: mail, MAIL_FROM_ADDRESS: "a@meltiply.test" }, true],
    ["no mail binding", { MAIL_FROM_ADDRESS: "a@meltiply.test" }, false],
    ["no sender address", { MAIL: mail }, false],
  ])("%s", (_example, settings, available) => {
    expect(emailDeliveryAvailable(fakeEnv(settings))).toEqual(available);
  });
});

describe("normalizeSignatureTemplates", () => {
  it("no template", () => {
    expect(normalizeSignatureTemplates([])).toEqual([]);
  });

  it("padded text, an upper-case id and a stale position", () => {
    const input = [
      {
        ...template,
        body: " From {brand_profile} ",
        id: A.toUpperCase(),
        name: " Main ",
        position: 7,
      },
    ];

    expect(normalizeSignatureTemplates(input)).toEqual([
      { body: "From {brand_profile}", id: A, is_default: true, name: "Main", position: 0 },
    ]);
  });

  it("two templates keep their order", () => {
    const input = [
      { ...template, is_default: false },
      { ...template, id: B, name: "Café 🚀" },
    ];

    expect(normalizeSignatureTemplates(input)).toEqual([
      { ...template, is_default: false },
      { ...template, id: B, name: "Café 🚀", position: 1 },
    ]);
  });

  it.each([
    ["every placeholder", { body: "{brand_profile} {channel} {platform}" }],
    ["a name of 80 characters", { name: "n".repeat(80) }],
    ["a body of 1000 characters", { body: "b".repeat(1_000) }],
  ])("%s", (_example, patch) => {
    expect(normalizeSignatureTemplates([{ ...template, ...patch }])).toEqual([
      { ...template, ...patch },
    ]);
  });

  it("ten templates", () => {
    const input = Array.from({ length: 10 }, (_, index) => ({
      ...template,
      id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index}`,
      is_default: index === 0,
    }));

    expect(normalizeSignatureTemplates(input)).toHaveLength(10);
  });

  it.each([
    [
      "eleven templates",
      Array.from({ length: 11 }, () => template),
      "Use no more than 10 signature templates.",
    ],
    [
      "no default",
      [{ ...template, is_default: false }],
      "Choose exactly one default signature template.",
    ],
    [
      "two defaults",
      [template, { ...template, id: B }],
      "Choose exactly one default signature template.",
    ],
    [
      "an id that is not a UUID",
      [{ ...template, id: "one" }],
      "Signature template ids must be unique UUIDs.",
    ],
    [
      "ids that differ only in case",
      [template, { ...template, id: A.toUpperCase(), is_default: false }],
      "Signature template ids must be unique UUIDs.",
    ],
    [
      "a blank name",
      [{ ...template, name: "  " }],
      "Signature template names must be between 1 and 80 characters.",
    ],
    [
      "a name of 81 characters",
      [{ ...template, name: "n".repeat(81) }],
      "Signature template names must be between 1 and 80 characters.",
    ],
    [
      "a blank body",
      [{ ...template, body: " " }],
      "Signature template bodies must be between 1 and 1000 characters.",
    ],
    [
      "a body of 1001 characters",
      [{ ...template, body: "b".repeat(1_001) }],
      "Signature template bodies must be between 1 and 1000 characters.",
    ],
    [
      "an unsupported placeholder",
      [{ ...template, body: "Hi {unknown}" }],
      "Unsupported signature placeholder: {unknown}.",
    ],
  ])("%s", (_example, input, message) => {
    expect(thrownBy(() => normalizeSignatureTemplates(input))).toEqual(invalid(message));
  });
});

describe("normalizeNotificationRecipients", () => {
  it.each([
    ["no recipient", [], []],
    [
      "padding, capitals and a duplicate",
      [" Ops@Example.com ", "a@meltiply.local", "ops@example.com"],
      ["ops@example.com", "a@meltiply.local"],
    ],
  ])("%s", (_example, input, recipients) => {
    expect(normalizeNotificationRecipients(input)).toEqual(recipients);
  });

  it("twenty recipients", () => {
    const input = Array.from({ length: 20 }, (_, index) => `r${index}@example.com`);

    expect(normalizeNotificationRecipients(input)).toEqual(input);
  });

  it.each([
    [
      "twenty-one recipients",
      Array.from({ length: 21 }, (_, index) => `r${index}@example.com`),
      "Use no more than 20 email recipients.",
    ],
    ["text that is not an address", ["not-an-address"], "Use valid email recipients."],
    ["a domain without a dot", ["ops@localhost"], "Use valid email recipients."],
  ])("%s", (_example, input, message) => {
    expect(thrownBy(() => normalizeNotificationRecipients(input))).toEqual(invalid(message));
  });
});

describe("validateNotifications", () => {
  it("email enabled with a recipient on an installation with mail", () => {
    expect(validateNotifications(emailing(true, [" A@Example.com "]), true)).toEqual(
      emailing(true, ["a@example.com"]),
    );
  });

  it("email disabled without recipients or mail", () => {
    expect(validateNotifications(quiet, false)).toEqual(quiet);
  });

  it("email enabled without mail", () => {
    expect(thrownBy(() => validateNotifications(emailing(true, ["a@example.com"]), false))).toEqual(
      new CoreApiError(
        422,
        "notification_channel_unavailable",
        "Email delivery is not configured for this installation.",
      ),
    );
  });

  it("email enabled without a recipient", () => {
    expect(thrownBy(() => validateNotifications(emailing(true, []), true))).toEqual(
      invalid("Add at least one email recipient before enabling email."),
    );
  });

  it.each([
    ["a missing publication event", { ...quiet, events: { channel_disconnected: true } }],
    ["a missing channel event", { ...quiet, events: { publication_failed: true } }],
    ["no email channel", { ...quiet, channels: {} }],
    [
      "recipients that are not a list",
      { ...quiet, channels: { email: { enabled: false, recipients: "a" } } },
    ],
  ])("%s", (_example, input) => {
    expect(thrownBy(() => validateNotifications(input as never, true))).toEqual(
      invalid("Notification choices are invalid."),
    );
  });
});

describe("validatedPreferences", () => {
  it("a document without templates", () => {
    const input = { notifications: quiet, timezone: null } as never;

    expect(validatedPreferences(input, false)).toEqual({ notifications: quiet, signatures: [] });
  });

  it("a document with a template", () => {
    const input = { notifications: quiet, signature_templates: [template], timezone: "UTC" };

    expect(validatedPreferences(input, false)).toEqual({
      notifications: quiet,
      signatures: [template],
    });
  });
});

describe("preferencesError", () => {
  it("an API error", () => {
    const cause = invalid("Use valid email recipients.");

    expect(preferencesError(cause)).toBe(cause);
  });

  it("an unexpected error", () => {
    expect(preferencesError(new TypeError("trim"))).toEqual(
      invalid("Publishing preferences are invalid."),
    );
  });
});

describe("mapPreferences", () => {
  it("nothing stored", () => {
    expect(mapPreferences(undefined, false)).toEqual({
      email_available: false,
      notifications: quiet,
      signature_templates: [],
      timezone: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it.each([
    ["a stored row with a date", new Date("2026-02-01T00:00:00.000Z")],
    ["a stored row with a timestamp string", "2026-02-01T00:00:00.000Z"],
  ])("%s", (_example, updated_at) => {
    const row = {
      notification_preferences: quiet,
      signature_templates: [template],
      timezone: "Europe/Paris",
      updated_at,
    };

    expect(mapPreferences(row, true)).toEqual({
      email_available: true,
      notifications: quiet,
      signature_templates: [template],
      timezone: "Europe/Paris",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
  });
});
