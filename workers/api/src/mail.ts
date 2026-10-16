import { Context, Effect, Layer } from "effect";
import { MailSubmissionError, type MailSubmissionClassification } from "@meltiply/domain";
import { isMailSenderAddress, isMailSenderName } from "@meltiply/domain/mail-content";

/**
 * Structured sender or recipient identity. `email` is a bare address and
 * `name` an optional display name — never a combined `"Name <a@b>"` string, so
 * callers cannot smuggle header syntax through the sender field.
 */
export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

/**
 * Provider-neutral outbound transactional message. One recipient with subject,
 * HTML, and plain-text bodies; the sender identity is configured separately via
 * `mailSenderConfiguration`, not carried per message.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Neutral acknowledgement that the provider accepted a submission. It is
 * acceptance for delivery, not proof of inbox placement, and carries no
 * vendor-shaped fields beyond the submission identifier.
 */
interface MailReceipt {
  readonly submissionId: string;
}

/**
 * Promise-native mail capability consumed by Better Auth callbacks. Rejects
 * only with `MailSubmissionError`; implementations submit exactly once and
 * never retry, so an `ambiguous` failure may already have been accepted
 * remotely and must not be resubmitted by callers.
 */
export interface MailSender {
  readonly send: (message: MailMessage) => Promise<MailReceipt>;
}

/**
 * Deterministic Cloudflare `send()` error codes mapped to the neutral failure
 * taxonomy. Submission-shape errors (validation, headers, size, sender and
 * recipient policy, definitive delivery failure) are `rejected`; throttling and
 * daily quota stay distinct from the provider's internal service failure.
 * Codes absent from this table fall through to `ambiguous` because an
 * unrecognized post-dispatch error cannot prove the write did not happen.
 */
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

/**
 * Maps a native `send()` rejection to a sanitized `MailSubmissionError`. Only
 * own vendor `code` entries influence the classification, and the code (never
 * the vendor message, which may echo submitted content) is appended to the
 * fixed per-classification message for operators. Unknown strings, including
 * inherited object keys, and missing codes or transport failures are `ambiguous`.
 */
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

/**
 * Creates the single `MailSender` implementation backed by the generated
 * `SendEmail` contract. Named senders use a structured identity; nameless
 * senders use a bare address because generated `EmailAddress` requires a name.
 *
 * Configuration is checked before any dispatch: a missing binding, a binding
 * whose `send` is not callable (for example an absent or wrongly-shaped
 * binding, which would otherwise surface as a TypeError), or a missing sender
 * rejects `unavailable` and the binding is never invoked. Each call submits
 * exactly once — no retry, no resubmission — and a resolved promise whose
 * receipt lacks a non-empty `messageId` is reported `ambiguous` rather than
 * trusted as acceptance.
 *
 * @param binding - The `send_email` Worker binding (`env.MAIL`), or undefined.
 * @param sender - Configured sender identity from `mailSenderConfiguration`.
 * @returns Promise-native sender rejecting only with `MailSubmissionError`.
 */
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

/**
 * Trims Worker variables, then applies the shared address/display-name policy.
 * `MAIL_FROM_ADDRESS` must be a bare dot-atom email address; malformed values
 * yield `undefined` so production fails closed as `unavailable` rather than
 * dispatching an invalid sender. `MAIL_FROM_NAME` is optional; a nonblank unsafe
 * name also fails closed instead of silently dropping it. Blank names are omitted.
 *
 * @param env - Worker environment exposing the neutral mail variables.
 * @returns The validated `MailAddress`, or undefined when unusable.
 */
export function mailSenderConfiguration(env: {
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
}): MailAddress | undefined {
  const email = env.MAIL_FROM_ADDRESS?.trim();
  if (email === undefined || !isMailSenderAddress(email)) {
    return undefined;
  }
  const name = env.MAIL_FROM_NAME?.trim();
  if (name !== undefined && name.length > 0) {
    if (!isMailSenderName(name)) {
      return undefined;
    }
    return { email, name };
  }
  return { email };
}

/**
 * Effect service shape for outbound mail. `send` has no unresolved
 * requirements and fails only with the typed `MailSubmissionError` contract.
 */
export interface MailServiceShape {
  readonly send: (message: MailMessage) => Effect.Effect<MailReceipt, MailSubmissionError, never>;
}

/**
 * Effect service tag for transactional mail submission.
 */
export class MailService extends Context.Service<MailService, MailServiceShape>()("MailService") {}

/**
 * Creates the live `MailService` Layer over a `MailSender`, sharing one
 * submission implementation between the Promise-native and Effect surfaces.
 *
 * `Effect.tryPromise` maps rejections explicitly: typed `MailSubmissionError`
 * pass through untouched while foreign rejections become `ambiguous` — the
 * safe default for an unknown post-dispatch outcome. Effect interruption
 * cannot cancel the in-flight native `send()` and cannot prove the write did
 * not happen; the host retains the interrupt `Cause`, and neither this Layer
 * nor the adapter ever resubmits after an uncertain outcome. Each send is
 * recorded as a `mail.send` span; no message fields become span attributes so
 * bodies, links, and recipients never reach trace exports.
 *
 * @param sender - Submission implementation (e.g. `createCloudflareMailSender`).
 * @returns Layer providing `MailService` built from the current invocation's sender.
 */
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

/**
 * Creates an isolated test Layer for `MailService`. Default behavior is a
 * deterministic accepted submission so workflow tests exercise the mail seam
 * without a binding; each call site gets its own service instance via `impl`,
 * keeping doubles isolated per test.
 *
 * @param impl - Optional `send` override for failure/success scenarios.
 * @returns Layer providing the stubbed `MailService`.
 */
export function createMailServiceTest(
  impl?: Partial<MailServiceShape>,
): Layer.Layer<MailService, never, never> {
  const service: MailServiceShape = {
    send: impl?.send ?? (() => Effect.succeed({ submissionId: "test-submission-id" })),
  };
  return Layer.succeed(MailService, service);
}
