import { MailSubmissionError } from "@meltiply/domain";
import { effectTracerLayer, type LogContext, type OtlpSpanInput } from "@meltiply/observability";
import { Effect, type Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  createCloudflareMailSender,
  createMailServiceLive,
  createMailServiceTest,
  MailService,
  type MailMessage,
  type MailSender,
} from "../src/mail";

const message: MailMessage = {
  html: '<p><a href="https://app.test/verify?token=secret-token">Verify</a></p>',
  subject: "Verify your account",
  text: "Verify at https://app.test/verify?token=secret-token",
  to: "creator@example.com",
};

const sender = { email: "auth@meltiply.test", name: "Meltiply" };

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

function vendorError(code: string): Error & { code: string } {
  return Object.assign(new Error("vendor detail <creator@example.com> token=secret-token"), {
    code,
  });
}

async function sendFailure(
  mailSender: MailSender,
  mail: MailMessage = message,
): Promise<MailSubmissionError> {
  try {
    await mailSender.send(mail);
  } catch (error) {
    if (error instanceof MailSubmissionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected send to reject");
}

function serviceFailure(
  layer: Layer.Layer<MailService, never, never>,
  mail: MailMessage = message,
): Promise<MailSubmissionError> {
  return Effect.runPromise(
    Effect.flip(
      Effect.provide(
        Effect.flatMap(MailService, (service) => service.send(mail)),
        layer,
      ),
    ),
  );
}

describe("createCloudflareMailSender", () => {
  it("submits one named structured message and resolves a neutral receipt", async () => {
    const { binding, calls } = bindingWith({ messageId: "cf-msg-1" });

    expect(await createCloudflareMailSender(binding, sender).send(message)).toEqual({
      submissionId: "cf-msg-1",
    });
    expect(calls).toEqual([
      {
        from: { email: "auth@meltiply.test", name: "Meltiply" },
        html: message.html,
        subject: "Verify your account",
        text: message.text,
        to: "creator@example.com",
      },
    ]);
  });

  it("formats a bare sender address as a plain string", async () => {
    const { binding, calls } = bindingWith({ messageId: "cf-msg-2" });

    await createCloudflareMailSender(binding, { email: "auth@meltiply.test" }).send(message);

    expect(calls[0]?.from).toEqual("auth@meltiply.test");
  });

  it.each([
    ["missing binding", undefined, sender],
    ["missing sender", bindingWith({ messageId: "cf-msg-3" }).binding, undefined],
    ["non-callable binding", {} as SendEmail, sender],
  ])("fails unavailable without dispatch on %s", async (_example, binding, from) => {
    const error = await sendFailure(createCloudflareMailSender(binding, from));

    expect(error.classification).toEqual("unavailable");
  });

  it("does not dispatch when the sender is missing", async () => {
    const { binding, calls } = bindingWith({ messageId: "cf-msg-3" });

    await sendFailure(createCloudflareMailSender(binding, undefined));

    expect(calls).toEqual([]);
  });

  it.each([
    ["E_RECIPIENT_SUPPRESSED", "rejected"],
    ["E_SENDER_NOT_VERIFIED", "rejected"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "rejected"],
    ["E_RECIPIENT_NOT_ALLOWED", "rejected"],
    ["E_VALIDATION_ERROR", "rejected"],
    ["E_DELIVERY_FAILED", "rejected"],
    ["E_RATE_LIMIT_EXCEEDED", "rate_limit"],
    ["E_DAILY_LIMIT_EXCEEDED", "quota"],
    ["E_INTERNAL_SERVER_ERROR", "infrastructure"],
  ] as const)(
    "classifies %s as %s without leaking recipient or vendor text",
    async (code, kind) => {
      const error = await sendFailure(
        createCloudflareMailSender(bindingWith(vendorError(code)).binding, sender),
      );

      expect(error.classification).toEqual(kind);
      expect(error.message).not.toContain("creator@example.com");
      expect(error.message).not.toContain("secret-token");
      expect(error.message).not.toContain("vendor detail");
      expect(error).not.toHaveProperty("cause");
    },
  );

  it.each(["E_FUTURE_UNDOCUMENTED", "constructor", "toString", "__proto__"])(
    "classifies unknown or inherited code %s as sanitized ambiguous",
    async (code) => {
      const { binding, calls } = bindingWith(vendorError(code));
      const error = await sendFailure(createCloudflareMailSender(binding, sender));

      expect(error).toEqual(
        new MailSubmissionError({
          classification: "ambiguous",
          message:
            "The mail submission outcome is uncertain; the message may already have been accepted.",
        }),
      );
      expect(calls).toHaveLength(1);
    },
  );

  it("classifies an uncoded rejection as ambiguous", async () => {
    const { binding } = bindingWith(new Error("socket hangup mid-request"));

    expect((await sendFailure(createCloudflareMailSender(binding, sender))).classification).toEqual(
      "ambiguous",
    );
  });

  it.each([
    ["missing messageId", {} as EmailSendResult],
    ["empty messageId", { messageId: "" }],
  ])("classifies a malformed receipt (%s) as ambiguous", async (_example, receipt) => {
    const error = await sendFailure(
      createCloudflareMailSender({ send: async () => receipt }, sender),
    );

    expect(error.classification).toEqual("ambiguous");
  });

  it("dispatches once per send call even when the outcome is uncertain", async () => {
    const { binding, calls } = bindingWith(new Error("connection reset after write"));
    const mailSender = createCloudflareMailSender(binding, sender);

    await sendFailure(mailSender);
    await sendFailure(mailSender);

    expect(calls).toHaveLength(2);
  });
});

describe("MailService", () => {
  it("propagates typed MailSubmissionError from the sender", async () => {
    const error = await serviceFailure(
      createMailServiceLive(createCloudflareMailSender(undefined, sender)),
    );

    expect(error.classification).toEqual("unavailable");
  });

  it("maps foreign rejections to sanitized ambiguous errors", async () => {
    const error = await serviceFailure(
      createMailServiceLive({
        send: async () => {
          throw new Error("opaque transport failure");
        },
      }),
    );

    expect(error.classification).toEqual("ambiguous");
    expect(error.message).not.toContain("opaque transport failure");
  });

  it("preserves MailSubmissionError on the typed failure channel", async () => {
    const quota = new MailSubmissionError({
      classification: "quota",
      message: "quota exhausted",
    });
    const error = await serviceFailure(
      createMailServiceLive({
        send: async () => {
          throw quota;
        },
      }),
    );

    expect(error).toEqual(quota);
  });

  it("emits a mail.send span without recipient or content attributes", async () => {
    const exportedSpans: OtlpSpanInput[] = [];
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace-mail-send",
      version: "1.0.0",
    };
    const layer = createMailServiceLive(
      createCloudflareMailSender(bindingWith({ messageId: "cf-msg-5" }).binding, sender),
    );

    await Effect.runPromise(
      Effect.flatMap(MailService, (service) => service.send(message)).pipe(
        Effect.provide(layer),
        Effect.provide(
          effectTracerLayer(context, {
            exporter: async (_env, span) => {
              exportedSpans.push(span);
            },
          }),
        ),
      ),
    );

    expect(exportedSpans).toHaveLength(1);
    expect(exportedSpans[0]?.name).toEqual("mail.send");
    expect(JSON.stringify(exportedSpans[0]?.attributes ?? {})).not.toContain("creator@example.com");
  });
});

describe("createMailServiceTest", () => {
  it("keeps default and overridden layers isolated across invocations", async () => {
    const rejected = new MailSubmissionError({
      classification: "rejected",
      message: "suppressed recipient",
    });
    const failing = createMailServiceTest({ send: () => Effect.fail(rejected) });
    const passing = createMailServiceTest();

    expect(await serviceFailure(failing)).toEqual(rejected);
    expect(
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(MailService, (service) => service.send(message)),
          passing,
        ),
      ),
    ).toEqual({ submissionId: "test-submission-id" });
    expect(await serviceFailure(failing)).toEqual(rejected);
  });
});
