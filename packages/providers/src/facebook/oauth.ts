import { malformed } from "../failures";
import { META_GRAPH_API_VERSION } from "../meta";
import {
  addSeconds,
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
  OAuthExchangeResult,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import { bearer, boundedString, providerIdentifier, record, required } from "../values";
import {
  decodeRefreshSecret,
  encodeRefreshSecret,
  expiryDiagnostic,
  facebookInspectedExpiry,
  facebookPageConnection,
  grantedPermissions,
  nextPageCursor,
  oauthMalformed,
} from "./responses";
import {
  FACEBOOK_BUSINESS_DISCOVERY_SCOPE,
  FACEBOOK_CONFIGURED_SCOPES,
  FACEBOOK_LIMITS,
  FACEBOOK_PUBLISHING_SCOPES,
  graphUrl,
  nodeUrl,
} from "./types";

const discoveryPageSize = 100;
const defaultMaxDiscoveredPages = 1_000;
const maxBusinessUsers = 1_000;
const businessEdgeConcurrency = 4;
const businessUsersPath = "me/business_users";

export function discoveryRequestLimit(override: number | undefined): number {
  return override ?? 1_000;
}

export function createFacebookOAuth(
  runtime: AdapterRuntime,
  maxDiscoveryRequests: number,
  maxDiscoveredPages = defaultMaxDiscoveredPages,
) {
  const { clientId, clientSecret, http, now, redirectUri } = runtime;
  const tokenUrl = graphUrl("oauth/access_token").toString();
  const authorizationEndpoint = `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`;

  const getGraph = async (context: ProviderRequestContext, accessToken: string, url: URL) =>
    (
      await http.request(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: url.toString(),
      })
    ).body;

  const exchangeLongLived = async (
    context: ProviderRequestContext,
    currentToken: string,
  ): Promise<{ accessToken: string; expiresAt?: string }> => {
    const body = record(
      await postForm(http, context, tokenUrl, {
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: required("userAccessToken", currentToken, FACEBOOK_LIMITS.tokenMaxChars),
        grant_type: "fb_exchange_token",
      }),
    );
    const accessToken = boundedString(body?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
    if (!accessToken) throw oauthMalformed("long_lived_token");
    if (boundedString(body?.token_type, 32)?.toLowerCase() !== "bearer") {
      throw oauthMalformed("token_type");
    }
    const lifetime = body?.expires_in;
    const exchangedAt = now();
    if (lifetime === undefined) {
      const debugUrl = graphUrl("debug_token");
      debugUrl.searchParams.set("input_token", accessToken);
      const inspected = await getGraph(context, `${clientId}|${clientSecret}`, debugUrl);
      const expiresAt = facebookInspectedExpiry(inspected, clientId, exchangedAt);
      return expiresAt === undefined ? { accessToken } : { accessToken, expiresAt };
    }
    try {
      return {
        accessToken,
        expiresAt: addSeconds(exchangedAt, lifetime, FACEBOOK_LIMITS.tokenLifetimeMaxSeconds),
      };
    } catch {
      throw oauthMalformed(
        "token_expiry",
        expiryDiagnostic("exchange", { expiry: lifetime, lifetime_seconds: lifetime }),
      );
    }
  };

  const readPermissions = async (context: ProviderRequestContext, accessToken: string) =>
    grantedPermissions(await getGraph(context, accessToken, graphUrl("me/permissions")));

  return {
    authorizationUrl: (input: OAuthAuthorizationInput): string =>
      authorizationCodeUrl(authorizationEndpoint, input, redirectUri, {
        client_id: clientId,
        scope: [...FACEBOOK_CONFIGURED_SCOPES, FACEBOOK_BUSINESS_DISCOVERY_SCOPE].join(","),
      }),

    async exchangeAuthorizationCode(
      context: ProviderRequestContext,
      input: OAuthExchangeInput,
    ): Promise<OAuthExchangeResult> {
      assertConfiguredRedirectUri(input.redirectUri, redirectUri);
      const shortBody = await exchangeAuthorizationCodeForm(http, context, {
        clientId,
        clientSecret,
        code: input.code,
        redirectUri,
        tokenUrl,
      });
      const shortToken = boundedString(
        record(shortBody)?.access_token,
        FACEBOOK_LIMITS.tokenMaxChars,
      );
      if (!shortToken) throw oauthMalformed("authorization_token");

      const longToken = await exchangeLongLived(context, shortToken);
      const grantedScopes = await readPermissions(context, longToken.accessToken);
      if (!FACEBOOK_PUBLISHING_SCOPES.every((scope) => grantedScopes.includes(scope))) {
        return { accounts: [] };
      }

      const businessPaths: string[] = [];
      const businessUsers = new Set<string>();
      let discoveredCount = 0;
      let requestCount = 0;
      let failed = false;

      const discover = async (path: string): Promise<OAuthConnection[]> => {
        const isBusinessUserList = path === businessUsersPath;
        const candidates: OAuthConnection[] = [];
        const candidateIds = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
          if (failed) break;
          if (requestCount >= maxDiscoveryRequests) throw oauthMalformed("page_pagination");
          requestCount += 1;
          const url = graphUrl(path);
          url.searchParams.set(
            "fields",
            isBusinessUserList ? "id" : "id,name,access_token,tasks,picture,link",
          );
          url.searchParams.set("limit", String(discoveryPageSize));
          if (cursor !== undefined) url.searchParams.set("after", cursor);
          const body = record(await getGraph(context, longToken.accessToken, url));
          if (!Array.isArray(body?.data) || body.data.length > discoveryPageSize) {
            throw oauthMalformed("page_list");
          }
          if (isBusinessUserList) {
            for (const value of body.data) {
              const id = providerIdentifier(record(value)?.id);
              if (!id) throw oauthMalformed("business_user_identity");
              if (businessUsers.has(id)) continue;
              businessUsers.add(id);
              if (businessUsers.size > maxBusinessUsers) throw oauthMalformed("business_user_list");
              businessPaths.push(`${id}/assigned_pages`);
            }
          } else {
            discoveredCount += body.data.length;
            if (discoveredCount > maxDiscoveredPages) throw oauthMalformed("page_list");
            for (const value of body.data) {
              const connection = facebookPageConnection(value, longToken, grantedScopes);
              if (connection && !candidateIds.has(connection.account.id)) {
                candidateIds.add(connection.account.id);
                candidates.push(connection);
              }
            }
          }
          cursor = nextPageCursor(body.paging, seenCursors);
        } while (cursor !== undefined);
        return candidates;
      };

      const eligible = await discover("me/accounts");
      if (grantedScopes.includes(FACEBOOK_BUSINESS_DISCOVERY_SCOPE)) {
        await discover(businessUsersPath);
      }
      const businessResults: OAuthConnection[][] = [];
      const edges = businessPaths.entries();
      const outcomes = await Promise.allSettled(
        Array.from(
          { length: Math.min(businessEdgeConcurrency, businessPaths.length) },
          async () => {
            for (const [index, path] of edges) {
              if (failed) return;
              try {
                businessResults[index] = await discover(path);
              } catch (cause) {
                failed = true;
                throw cause;
              }
            }
          },
        ),
      );
      const rejection = outcomes.find((outcome) => outcome.status === "rejected");
      if (rejection) throw rejection.reason;
      const identifiers = new Set(eligible.map((connection) => connection.account.id));
      for (const candidate of businessResults.flat()) {
        if (identifiers.has(candidate.account.id)) continue;
        identifiers.add(candidate.account.id);
        eligible.push(candidate);
      }
      return { accounts: eligible };
    },

    async refreshAccessToken(
      context: ProviderRequestContext,
      value: string,
    ): Promise<ProviderTokenSet> {
      const current = decodeRefreshSecret(value);
      const longToken = await exchangeLongLived(context, current.userAccessToken);
      const page = record(
        await getGraph(
          context,
          longToken.accessToken,
          nodeUrl(current.pageId, "id,name,access_token"),
        ),
      );
      const accessToken = boundedString(page?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
      if (providerIdentifier(page?.id) !== current.pageId || !accessToken) throw malformed();
      return {
        accessToken,
        ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
        refreshToken: encodeRefreshSecret({
          pageId: current.pageId,
          userAccessToken: longToken.accessToken,
        }),
        scopes: await readPermissions(context, longToken.accessToken),
      };
    },
  };
}
