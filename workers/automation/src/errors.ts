const urlPattern = /https?:\/\/\S+/gi;
const credentialPattern = /(token|secret|password)=\S+/gi;

export function safeErrorMessage(cause: unknown, fallback = "unknown job error"): string {
  return (cause instanceof Error ? cause.message : fallback)
    .replace(urlPattern, "[REDACTED_URL]")
    .replace(credentialPattern, "$1=[REDACTED]")
    .slice(0, 1_000);
}
