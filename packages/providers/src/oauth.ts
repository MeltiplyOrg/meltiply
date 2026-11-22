import { malformed } from "./failures";
import type { ProviderHttpClient } from "./http";
import type { OAuthAuthorizationInput, ProviderRequestContext } from "./types";
import { exactRedirectUri, formHeaders, required } from "./values";

const oauthStateMaxChars = 1_024;

/** OAuth token lifetime: a positive integer number of seconds no greater than `maxSeconds`. */
export function addSeconds(now: Date, value: unknown, maxSeconds: number): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxSeconds) {
    throw malformed();
  }
  return new Date(now.getTime() + value * 1_000).toISOString();
}

export function assertConfiguredRedirectUri(attempted: string, configured: string): void {
  if (exactRedirectUri(attempted) !== configured) {
    throw new TypeError("OAuth redirect URI does not match configuration");
  }
}

/** Builds a `response_type=code` authorization URL pinned to the configured callback. */
export function authorizationCodeUrl(
  endpoint: string,
  input: OAuthAuthorizationInput,
  configuredRedirectUri: string,
  parameters: Readonly<Record<string, string>>,
): string {
  assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  url.searchParams.set("redirect_uri", configuredRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", required("state", input.state, oauthStateMaxChars));
  return url.toString();
}

export async function postForm(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  url: string,
  fields: Readonly<Record<string, string>>,
): Promise<unknown> {
  const response = await http.request(context, {
    body: new URLSearchParams(fields),
    headers: formHeaders,
    method: "POST",
    url,
  });
  return response.body;
}

export interface AuthorizationCodeExchangeRequest {
  clientIdField?: "client_id" | "client_key";
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier?: string;
  redirectUri: string;
  tokenUrl: string;
}

/** Posts an `authorization_code` grant and returns the unparsed token body. */
export function exchangeAuthorizationCodeForm(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  request: AuthorizationCodeExchangeRequest,
): Promise<unknown> {
  return postForm(http, context, request.tokenUrl, {
    [request.clientIdField ?? "client_id"]: request.clientId,
    client_secret: request.clientSecret,
    code: required("authorizationCode", request.code),
    ...(request.codeVerifier === undefined ? {} : { code_verifier: request.codeVerifier }),
    grant_type: "authorization_code",
    redirect_uri: request.redirectUri,
  });
}
