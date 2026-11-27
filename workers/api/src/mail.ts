import { Context, Effect, Layer } from "effect";
import { MailSubmissionError, type MailSubmissionClassification } from "@meltiply/domain";

interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface MailReceipt {
  readonly submissionId: string;
}

export interface MailSender {
  readonly send: (message: MailMessage) => Promise<MailReceipt>;
}

const cloudflareSendErrorClassifications: Readonly<Record<string, MailSubmissionClassification>> = {
  E_CONTENT_TOO_LARGE: "rejected",
  E_DELIVERY_FAILED: "rejected",
  E_FIELD_MISSING: "rejected",
  E_HEADER_NAME_INVALID: "rejected",
  E_HEADERS_TOO_LARGE: "rejected",
  E_HEADERS_TOO_MANY: "rejected",
  E_HEADER_NOT_ALLOWED: "rejected",
  E_HEADER_USE_API_FIELD: "rejected",
  E_HEADER_VALUE_INVALID: "rejected",
  E_HEADER_VALUE_TOO_LONG: "rejected",
  E_RECIPIENT_NOT_ALLOWED: "rejected",
  E_RECIPIENT_SUPPRESSED: "rejected",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "rejected",
  E_SENDER_NOT_VERIFIED: "rejected",
  E_TOO_MANY_ATTACHMENTS: "rejected",
  E_TOO_MANY_RECIPIENTS: "rejected",
  E_VALIDATION_ERROR: "rejected",
  E_RATE_LIMIT_EXCEEDED: "rate_limit",
  E_DAILY_LIMIT_EXCEEDED: "quota",
  E_INTERNAL_SERVER_ERROR: "infrastructure",
};

const classificationMessages: Readonly<Record<MailSubmissionClassification, string>> = {
  unavailable:
    "Outbound mail is unavailable because the mail binding or sender configuration is missing.",
  rejected: "The mail service rejected the submission.",
  rate_limit: "The mail service rate limit was exceeded.",
  quota: "The mail service daily sending quota was exhausted.",
  infrastructure: "The mail service encountered an internal error.",
  ambiguous:
    "The mail submission outcome is uncertain; the message may already have been accepted.",
};

function classifySendFailure(cause: unknown): MailSubmissionError {
  if (cause instanceof MailSubmissionError) {
    return cause;
  }
  const code =
    cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  const classification =
    code !== undefined && Object.hasOwn(cloudflareSendErrorClassifications, code)
      ? cloudflareSendErrorClassifications[code]
      : undefined;
  if (classification === undefined) {
    return new MailSubmissionError({
      classification: "ambiguous",
      message: classificationMessages.ambiguous,
    });
  }
  return new MailSubmissionError({
    classification,
    message: `${classificationMessages[classification]} (${code})`,
  });
}

export function createCloudflareMailSender(
  binding: SendEmail | undefined,
  sender: MailAddress | undefined,
): MailSender {
  return {
    send: async (message) => {
      if (binding === undefined || sender === undefined || typeof binding.send !== "function") {
        throw new MailSubmissionError({
          classification: "unavailable",
          message: classificationMessages.unavailable,
        });
      }
      const from =
        sender.name !== undefined ? { email: sender.email, name: sender.name } : sender.email;
      const payload: EmailMessageBuilder = {
        from,
        html: message.html,
        subject: message.subject,
        text: message.text,
        to: message.to,
      };
      let result: unknown;
      try {
        result = await binding.send(payload);
      } catch (cause) {
        throw classifySendFailure(cause);
      }
      const messageId =
        typeof result === "object" &&
        result !== null &&
        "messageId" in result &&
        typeof result.messageId === "string"
          ? result.messageId
          : undefined;
      if (typeof messageId !== "string" || messageId.length === 0) {
        throw new MailSubmissionError({
          classification: "ambiguous",
          message: classificationMessages.ambiguous,
        });
      }
      return { submissionId: messageId };
    },
  };
}

export interface MailServiceShape {
  readonly send: (message: MailMessage) => Effect.Effect<MailReceipt, MailSubmissionError, never>;
}

export class MailService extends Context.Service<MailService, MailServiceShape>()("MailService") {}

export function createMailServiceLive(sender: MailSender): Layer.Layer<MailService, never, never> {
  const service: MailServiceShape = {
    send: (message) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof MailSubmissionError
            ? cause
            : new MailSubmissionError({
                classification: "ambiguous",
                message: classificationMessages.ambiguous,
              }),
        try: () => sender.send(message),
      }).pipe(Effect.withSpan("mail.send")),
  };
  return Layer.succeed(MailService, service);
}

export function createMailServiceTest(
  impl?: Partial<MailServiceShape>,
): Layer.Layer<MailService, never, never> {
  const service: MailServiceShape = {
    send: impl?.send ?? (() => Effect.succeed({ submissionId: "test-submission-id" })),
  };
  return Layer.succeed(MailService, service);
}
