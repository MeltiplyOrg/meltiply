import {
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
  postForm,
} from "../oauth";
import type { AdapterRuntime } from "../runtime";
import type {
  OAuthAuthorizationInput,
  OAuthConnection,
  OAuthExchangeInput,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import { bearer, required } from "../values";
import { parseGoogleTokenResponse, pkce, youtubeChannelAccount } from "./responses";
import {
  YOUTUBE_API_ORIGIN,
  YOUTUBE_AUTHORIZATION_ORIGIN,
  YOUTUBE_CONFIGURED_SCOPES,
  YOUTUBE_LIMITS,
  YOUTUBE_TOKEN_ORIGIN,
  type GoogleRequest,
} from "./types";

export function createYouTubeOAuth(runtime: AdapterRuntime, googleRequest: GoogleRequest) {
  const { clientId, clientSecret, redirectUri: configuredRedirectUri, http, now } = runtime;

  return {
    authorizationUrl(input: OAuthAuthorizationInput): string {
      return authorizationCodeUrl(
        `${YOUTUBE_AUTHORIZATION_ORIGIN}/o/oauth2/v2/auth`,
        input,
        configuredRedirectUri,
        {
          access_type: "offline",
          client_id: clientId,
          code_challenge: pkce("codeChallenge", input.codeChallenge),
          code_challenge_method: "S256",
          include_granted_scopes: "true",
          prompt: "consent select_account",
          scope: YOUTUBE_CONFIGURED_SCOPES.join(" "),
        },
      );
    },

    async exchangeAuthorizationCode(
      context: ProviderRequestContext,
      input: OAuthExchangeInput,
    ): Promise<OAuthConnection> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const tokenPayload = await exchangeAuthorizationCodeForm(http, context, {
        clientId,
        clientSecret,
        code: input.code,
        codeVerifier: pkce("codeVerifier", input.codeVerifier),
        redirectUri: configuredRedirectUri,
        tokenUrl: `${YOUTUBE_TOKEN_ORIGIN}/token`,
      });
      const tokens = parseGoogleTokenResponse(tokenPayload, now(), true);
      const channelUrl = new URL("/youtube/v3/channels", YOUTUBE_API_ORIGIN);
      channelUrl.searchParams.set("part", "id,snippet");
      channelUrl.searchParams.set("mine", "true");
      channelUrl.searchParams.set("maxResults", "2");
      const channelResponse = await googleRequest(context, {
        headers: bearer(tokens.accessToken),
        method: "GET",
        url: channelUrl.toString(),
      });
      return {
        accessToken: tokens.accessToken,
        account: youtubeChannelAccount(channelResponse.body),
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        scopes: tokens.scopes ?? [...YOUTUBE_CONFIGURED_SCOPES],
      };
    },

    async refreshAccessToken(
      context: ProviderRequestContext,
      refreshToken: string,
    ): Promise<ProviderTokenSet> {
      const currentRefreshToken = required(
        "refreshToken",
        refreshToken,
        YOUTUBE_LIMITS.tokenMaxChars,
      );
      const body = await postForm(http, context, `${YOUTUBE_TOKEN_ORIGIN}/token`, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
      });
      const tokens = parseGoogleTokenResponse(body, now(), false);
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken ?? currentRefreshToken,
        scopes: tokens.scopes ?? [],
      };
    },
  };
}
