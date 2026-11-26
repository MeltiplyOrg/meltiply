import type { AutomationEnv, MediaProcessorStub } from "../src/env";

export function fakeSendEmail(
  send: (message: EmailMessage | EmailMessageBuilder) => Promise<unknown>,
): SendEmail {
  const handler = async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    const result = await send(message);
    if (
      result !== null &&
      typeof result === "object" &&
      "messageId" in result &&
      typeof result.messageId === "string"
    ) {
      return { messageId: result.messageId };
    }
    return { messageId: "test-email-message-id" };
  };
  return { send: handler };
}

export function fakeMediaProcessor(
  process: MediaProcessorStub["process"],
): NonNullable<AutomationEnv["MEDIA_PROCESSOR"]> {
  return {
    get: () => ({ process }),
    idFromName: (name) => ({
      equals: (other) => other.toString() === name,
      name,
      toString: () => name,
    }),
  };
}
