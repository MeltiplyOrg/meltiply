export type ClientChannel = "web" | "cli" | "unknown";

export interface SessionProvenance {
  readonly clientChannel: ClientChannel;
  readonly userId: string;
}

const webSessionPaths = new Set(["/sign-in/email", "/sign-up/email", "/verify-email"]);

export function clientChannelFor(
  path: string | undefined,
  provenance: SessionProvenance | undefined,
  userId: string,
): ClientChannel {
  if (path === "/device/token") return "cli";
  if (provenance?.userId === userId) return provenance.clientChannel;
  if (path && (webSessionPaths.has(path) || path.startsWith("/two-factor/verify-"))) return "web";
  return "unknown";
}
