import { Effect, type Layer } from "effect";
import { MailSubmissionError } from "@meltiply/domain";
import { describe, expect, it, vi } from "vite-plus/test";
import { effectTracerLayer, type LogContext, type OtlpSpanInput } from "@meltiply/observability";

import {
  createCloudflareMailSender,
  createMailServiceLive,
  createMailServiceTest,
  MailService,
  mailSenderConfiguration,
  type MailMessage,
  type MailSender,
} from "../src/mail";

const message: MailMessage = {
  to: "creator@example.com",
  subject: "Verify your account",
  html: '<p><a href="https://app.test/verify?token=secret-token">Verify</a></p>',
  text: "Verify at https://app.test/verify?token=secret-token",
};

const sender = { email: "auth@meltiply.test", name: "Meltiply" };

/**
 * Implements both generated binding overloads, narrowing to a structured
 * builder at the recording seam because this adapter never sends raw MIME.
 * Records dispatches and returns the supplied outcome to pin count/classification.
 */
function bindingWith(outcome: { messageId: string } | Error) {
  const calls: EmailMessageBuilder[] = [];
  const binding: SendEmail = {
    send: async (payload: EmailMessage | EmailMessageBuilder) => {
      if (!("subject" in payload)) {
        throw new Error("expected a structured email builder");
      }
      calls.push(payload);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { binding, calls };
}

/** Builds a vendor-shaped rejection carrying a `code` property. */
function vendorError(code: string): Error & { code: string } {
  return Object.assign(new Error("vendor detail <creator@example.com>"), {
    code,
  });
}

/**
 * Resolves the rejection reason of a `MailSender.send` promise. The contract
 * rejects only with `MailSubmissionError`, so tests assert the concrete error.
 */
async function sendFailure(
  mailSender: MailSender,
  mail: MailMessage = message,
): Promise<MailSubmissionError> {
  try {
    await mailSender.send(mail);
  } catch (error) {
    // Contract promises MailSubmissionError rejections only; anything else is a
    // contract violation and rethrows so the test fails with the real error.
    if (error instanceof MailSubmissionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected send to reject");
}

/**
 * Runs `MailService.send` under the given layer and returns the typed failure.
 * `Effect.match` keeps `MailSubmissionError` on the observed channel while an
 * unexpected success throws inside `onSuccess`, failing the test as a defect
 * rather than smuggling a receipt out as an error.
 */
async function serviceFailure(
  layer: Layer.Layer<MailService, never, never>,
  mail: MailMessage = message,
): Promise<MailSubmissionError> {
  const program = Effect.gen(function* () {
    const service = yield* MailService;
    return yield* service.send(mail);
  }).pipe(
    Effect.provide(layer),
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => {
        throw new Error("expected mail send to fail");
      },
    }),
  );
  return Effect.runPromise(program);
}

describe("mailSenderConfiguration", () => {
  it("returns a bare-address sender with trimmed optional display name", () => {
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "  auth@meltiply.test  ",
        MAIL_FROM_NAME: "  Meltiply  ",
      }),
    ).toEqual({ email: "auth@meltiply.test", name: "Meltiply" });
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "auth@meltiply.test" })).toEqual({
      email: "auth@meltiply.test",
    });
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "   ",
      }),
    ).toEqual({ email: "auth@meltiply.test" });
  });

  it("rejects display-name syntax and header injection in the address", () => {
    const injected = "auth@meltiply.test\r\nBCC: victim@example.com";
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: injected })).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "Meltiply <auth@meltiply.test>",
      }),
    ).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "auth@meltiply.test," })).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "a@b@c.test" })).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "no-at-sign" })).toBeUndefined();
    expect(mailSenderConfiguration({})).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "   " })).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: `${"a".repeat(250)}@x.test`,
      }),
    ).toBeUndefined();
  });

  // Dot-atom senders require nonempty atoms; valid dotted and tagged names
  // remain usable while malformed separators fail before mail dispatch.
  it("rejects empty local-part atoms without rejecting valid dotted senders", () => {
    for (const email of [
      ".sender@example.com",
      "sender.@example.com",
      "sender..name@example.com",
    ]) {
      expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: email })).toBeUndefined();
    }
    const email = "sender.name+tag@example.com";
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: email })).toEqual({
      email,
    });
  });

  it("fails closed on an unsafe display name instead of dropping it", () => {
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "Meltiply\r\nInjected: yes",
      }),
    ).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "Bad <name>",
      }),
    ).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "n".repeat(201),
      }),
    ).toBeUndefined();
  });
});

describe("createCloudflareMailSender", () => {
  it("submits one structured message per send and resolves a neutral receipt", async () => {
    const { binding, calls } = bindingWith({ messageId: "cf-msg-1" });
    const mailSender = createCloudflareMailSender(binding, sender);

    await expect(mailSender.send(message)).resolves.toEqual({
      submissionId: "cf-msg-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      from: { email: "auth@meltiply.test", name: "Meltiply" },
      to: "creator@example.com",
      subject: "Verify your account",
      html: message.html,
      text: message.text,
    });

    // Generated EmailAddress requires a name, so the nameless neutral sender
    // reaches the binding as a bare string rather than an incomplete identity.
    const { binding: bareBinding, calls: bareCalls } = bindingWith({
      messageId: "cf-msg-2",
    });
    await createCloudflareMailSender(bareBinding, {
      email: "auth@meltiply.test",
    }).send(message);
    expect(bareCalls[0]?.from).toBe("auth@meltiply.test");
  });

  it("fails unavailable without dispatch when the binding is missing", async () => {
    const mailSender = createCloudflareMailSender(undefined, sender);
    const error = await sendFailure(mailSender);

    expect(error).toMatchObject({ classification: "unavailable" });
  });

  it("fails unavailable without dispatch when the sender is missing", async () => {
    const { binding, calls } = bindingWith({ messageId: "cf-msg-3" });
    const mailSender = createCloudflareMailSender(binding, undefined);
    const error = await sendFailure(mailSender);

    expect(error).toMatchObject({ classification: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("fails unavailable without dispatch when the binding's send is not callable", async () => {
    const broken = {} as SendEmail;
    const mailSender = createCloudflareMailSender(broken, sender);
    const error = await sendFailure(mailSender);

    expect(error).toMatchObject({ classification: "unavailable" });
  });

  it("classifies suppressed recipients as deterministic rejection", async () => {
    const { binding } = bindingWith(vendorError("E_RECIPIENT_SUPPRESSED"));
    const error = await sendFailure(createCloudflareMailSender(binding, sender));

    expect(error).toMatchObject({
      classification: "rejected",
      message: expect.stringContaining("E_RECIPIENT_SUPPRESSED"),
    });
  });

  it("distinguishes rate limiting from daily quota exhaustion", async () => {
    const rate = await sendFailure(
      createCloudflareMailSender(bindingWith(vendorError("E_RATE_LIMIT_EXCEEDED")).binding, sender),
    );
    const quota = await sendFailure(
      createCloudflareMailSender(
        bindingWith(vendorError("E_DAILY_LIMIT_EXCEEDED")).binding,
        sender,
      ),
    );

    expect(rate).toMatchObject({ classification: "rate_limit" });
    expect(quota).toMatchObject({ classification: "quota" });
  });

  it("classifies the provider's internal service error as infrastructure", async () => {
    const error = await sendFailure(
      createCloudflareMailSender(
        bindingWith(vendorError("E_INTERNAL_SERVER_ERROR")).binding,
        sender,
      ),
    );

    expect(error).toMatchObject({ classification: "infrastructure" });
  });

  it("classifies sender-policy and validation codes as rejected", async () => {
    for (const code of [
      "E_SENDER_NOT_VERIFIED",
      "E_SENDER_DOMAIN_NOT_AVAILABLE",
      "E_RECIPIENT_NOT_ALLOWED",
      "E_VALIDATION_ERROR",
      "E_DELIVERY_FAILED",
    ]) {
      const error = await sendFailure(
        createCloudflareMailSender(bindingWith(vendorError(code)).binding, sender),
      );
      expect(error).toMatchObject({ classification: "rejected" });
    }
  });

  // Unknown codes must not inherit Object.prototype classifications: retain a
  // sanitized ambiguous result and dispatch once so callers never revoke on it.
  it("reports unknown and inherited post-dispatch codes as sanitized ambiguous errors", async () => {
    for (const code of ["E_FUTURE_UNDOCUMENTED", "constructor", "toString", "__proto__"]) {
      const { binding, calls } = bindingWith(vendorError(code));
      const error = await sendFailure(createCloudflareMailSender(binding, sender));

      expect(error).toMatchObject({
        classification: "ambiguous",
        message:
          "The mail submission outcome is uncertain; the message may already have been accepted.",
      });
      expect(typeof error.classification).toBe("string");
      expect(error.message).not.toContain(code);
      expect(error.message).not.toContain("vendor detail");
      expect(error).not.toHaveProperty("cause");
      expect(calls).toHaveLength(1);
    }
  });

  it("reports an uncoded rejection as ambiguous", async () => {
    const { binding } = bindingWith(new Error("socket hangup mid-request"));
    const error = await sendFailure(createCloudflareMailSender(binding, sender));

    expect(error).toMatchObject({ classification: "ambiguous" });
  });

  it("reports a malformed resolved receipt as ambiguous, not accepted", async () => {
    const malformed = {
      send: async () => ({}),
    } as unknown as SendEmail;
    const error = await sendFailure(createCloudflareMailSender(malformed, sender));

    expect(error).toMatchObject({ classification: "ambiguous" });

    const emptyId: SendEmail = {
      send: async () => ({ messageId: "" }),
    };
    const emptyError = await sendFailure(createCloudflareMailSender(emptyId, sender));
    expect(emptyError).toMatchObject({ classification: "ambiguous" });
  });

  it("dispatches exactly once even when the outcome is uncertain", async () => {
    const { binding, calls } = bindingWith(new Error("connection reset after write"));
    const mailSender = createCloudflareMailSender(binding, sender);

    await sendFailure(mailSender);
    await sendFailure(mailSender);

    expect(calls).toHaveLength(2); // two calls, one binding hit each
  });

  it("sanitizes failures: no bodies, action links, or raw vendor errors", async () => {
    const { binding } = bindingWith(
      Object.assign(new Error("raw vendor detail for creator@example.com token=secret-token"), {
        code: "E_RECIPIENT_SUPPRESSED",
      }),
    );
    const error = await sendFailure(createCloudflareMailSender(binding, sender));

    expect(error.message).not.toContain("creator@example.com");
    expect(error.message).not.toContain("secret-token");
    expect(error.message).not.toContain("raw vendor detail");
    expect(error.message).not.toContain("https://app.test/verify");
    expect(error).not.toHaveProperty("cause");
  });
});

describe("MailService (Effect surface)", () => {
  it("propagates the typed MailSubmissionError from the sender", async () => {
    const layer = createMailServiceLive(createCloudflareMailSender(undefined, sender));
    const error = await serviceFailure(layer);

    expect(error).toBeInstanceOf(MailSubmissionError);
    expect(error).toMatchObject({ classification: "unavailable" });
  });

  it("maps foreign rejections to ambiguous rather than leaking raw errors", async () => {
    const layer = createMailServiceLive({
      send: async () => {
        throw new Error("opaque transport failure");
      },
    });
    const error = await serviceFailure(layer);

    expect(error).toBeInstanceOf(MailSubmissionError);
    expect(error).toMatchObject({ classification: "ambiguous" });
    expect(error.message).not.toContain("opaque transport failure");
  });

  it("keeps MailSubmissionError on the typed failure channel", async () => {
    const layer = createMailServiceLive({
      send: async () => {
        throw new MailSubmissionError({
          classification: "quota",
          message: "quota exhausted",
        });
      },
    });

    const program = Effect.gen(function* () {
      const service = yield* MailService;
      return yield* service.send(message);
    }).pipe(Effect.provide(layer), Effect.flip);

    const failure = await Effect.runPromise(program);
    expect(failure).toBeInstanceOf(MailSubmissionError);
    expect(failure).toMatchObject({ classification: "quota" });
  });

  it("emits a named mail.send span without recipient or content attributes", async () => {
    const exportedSpans: OtlpSpanInput[] = [];
    const exporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exportedSpans.push(span);
    });
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace-mail-send",
      version: "1.0.0",
    };

    const layer = createMailServiceLive(
      createCloudflareMailSender(bindingWith({ messageId: "cf-msg-5" }).binding, sender),
    );

    const program = Effect.gen(function* () {
      const service = yield* MailService;
      return yield* service.send(message);
    }).pipe(Effect.provide(layer), Effect.provide(effectTracerLayer(context, exporter)));

    await Effect.runPromise(program);

    expect(exporter).toHaveBeenCalledTimes(1);
    expect(exportedSpans[0]?.name).toBe("mail.send");
    expect(JSON.stringify(exportedSpans[0]?.attributes ?? {})).not.toContain("creator@example.com");
  });
});

describe("createMailServiceTest", () => {
  it("keeps injected behavior isolated per layer across invocations", async () => {
    const failing = createMailServiceTest({
      send: () =>
        Effect.fail(
          new MailSubmissionError({
            classification: "rejected",
            message: "suppressed recipient",
          }),
        ),
    });
    const passing = createMailServiceTest();

    const failure = await serviceFailure(failing);
    expect(failure).toMatchObject({ classification: "rejected" });

    // The failing layer's behavior must not bleed into an independent layer,
    // and the failing layer itself stays deterministic on repeat invocation.
    const program = Effect.gen(function* () {
      const service = yield* MailService;
      return yield* service.send(message);
    }).pipe(Effect.provide(passing));
    await expect(Effect.runPromise(program)).resolves.toEqual({
      submissionId: "test-submission-id",
    });

    const secondFailure = await serviceFailure(failing);
    expect(secondFailure).toMatchObject({ classification: "rejected" });
  });
});
