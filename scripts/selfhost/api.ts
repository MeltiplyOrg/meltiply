import { z } from "zod";
import { createApiApp } from "../../workers/api/src/app";
import { validateProductionBindings, type ApiWorkerEnv } from "../../workers/api/src/env";

type SelfhostEnv = ApiWorkerEnv & { SELFHOST_OPERATOR_SECRET: string };
const claimsSchema = z.object({
  iss: z.literal("meltiply-selfhost"),
  aud: z.literal("meltiply-operator"),
  sub: z.string().min(1),
  email: z.email(),
  exp: z.number().int(),
  iat: z.number().int(),
});

/** Decodes base64url JWT segments; malformed encodings reject before verification. */
function decode(segment: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new TypeError("Malformed operator token");
  return Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
    character.charCodeAt(0),
  );
}

const app = createApiApp({
  /** Validates short-lived locally minted operator credentials; no unsigned identity headers are trusted. */
  verifyAccessToken: async (env, token) => {
    const config = z.object({ SELFHOST_OPERATOR_SECRET: z.string().min(32) }).parse(env);
    const [header, payload, signature] = z
      .tuple([z.string(), z.string(), z.string()])
      .parse(token.split("."));
    const parsedHeader: unknown = JSON.parse(new TextDecoder().decode(decode(header)));
    z.object({ alg: z.literal("HS256"), typ: z.literal("JWT") })
      .strict()
      .parse(parsedHeader);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.SELFHOST_OPERATOR_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    if (!valid) throw new TypeError("Invalid operator signature");
    const decoded: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    const claims = claimsSchema.parse(decoded);
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.exp <= now ||
      claims.iat > now + 30 ||
      claims.exp - claims.iat > 900 ||
      claims.exp <= claims.iat
    )
      throw new TypeError("Expired or invalid operator token");
    return { subject: claims.sub, email: claims.email.toLowerCase() };
  },
});

export default {
  /** Validates bindings and scopes database/auth adapters to this invocation; only operator verification differs from managed Workers. */
  fetch(request: Request, env: SelfhostEnv, ctx: ExecutionContext) {
    validateProductionBindings(env);
    return app.fetch(request, { ...env }, ctx);
  },
};
