import { errorMessage } from "@meltiply/domain";

const urlPattern = /https?:\/\/\S+/gi;
const credentialPattern = /(token|secret|password)=\S+/gi;

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function safeErrorMessage(cause: unknown, fallback = "unknown job error"): string {
  return errorMessage(cause, fallback)
    .replace(urlPattern, "[REDACTED_URL]")
    .replace(credentialPattern, "$1=[REDACTED]")
    .slice(0, 1_000);
}
