import { addSeconds, malformed } from "./adapter-helpers";
import type { ProviderHttpClient } from "./http";
import { boundedString, record, required } from "./meta-common";
import type { ProviderRequestContext } from "./types";

/** Parameters for an OAuth 2.0 `authorization_code` form-encoded token exchange. */
export interface AuthorizationCodeExchangeRequest {
  clientIdField?: "client_id" | "client_key";
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier?: string;
  redirectUri: string;
  tokenUrl: string;
}

/**
 * Posts a form-encoded `authorization_code` grant to a provider's token
 * endpoint through the bounded `ProviderHttpClient`. Returns the raw JSON body
 * for provider-specific schema/token parsing.
 */
export async function exchangeAuthorizationCodeForm(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  request: AuthorizationCodeExchangeRequest,
): Promise<unknown> {
  const form = new URLSearchParams({
    [request.clientIdField ?? "client_id"]: request.clientId,
    client_secret: request.clientSecret,
    code: required("authorizationCode", request.code),
    ...(request.codeVerifier === undefined ? {} : { code_verifier: request.codeVerifier }),
    grant_type: "authorization_code",
    redirect_uri: request.redirectUri,
  });
  const response = await http.request<unknown>(context, {
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    url: request.tokenUrl,
  });
  return response.body;
}

/** Options controlling bounded bearer token response validation. */
export interface BearerTokenParseOptions {
  /** Whether a lowercase `token_type === "bearer"` check is case-insensitive (default false). */
  caseInsensitiveTokenType?: boolean;
  maxLifetimeSeconds: number;
  maxTokenChars: number;
  now: Date;
}

/**
 * Parses a standard Meta long-lived/refreshed bearer token response
 * (`access_token`, `token_type: "bearer"`, bounded integer `expires_in`).
 * Throws `malformed()` when any field violates bounds or type invariants.
 */
export function parseMetaBearerToken(
  value: unknown,
  options: BearerTokenParseOptions,
): { accessToken: string; expiresAt: string } {
  const body = record(value);
  const accessToken = boundedString(body?.access_token, options.maxTokenChars);
  const rawType = body?.token_type;
  const tokenTypeValid = options.caseInsensitiveTokenType
    ? boundedString(rawType, 32)?.toLowerCase() === "bearer"
    : rawType === "bearer";
  if (!accessToken || !tokenTypeValid) throw malformed();
  return {
    accessToken,
    expiresAt: addSeconds(options.now, body?.expires_in, options.maxLifetimeSeconds),
  };
}
