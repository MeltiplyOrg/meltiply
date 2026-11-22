import { addSeconds, malformed } from "../adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "../failures";
import type { ProviderHttpClient } from "../http";
import { OAUTH_STATE_MAX_CHARS, OAUTH_TOKEN_MAX_CHARS } from "../limits";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  providerIdentifier,
  record,
  required,
  secureUrl,
} from "../meta-common";
import { exchangeAuthorizationCodeForm } from "../oauth-helpers";
import type {
  OAuthAuthorizationInput,
  OAuthConnection,
  OAuthExchangeInput,
  OAuthExchangeResult,
  ProviderRequestContext,
  ProviderTokenSet,
} from "../types";
import {
  FACEBOOK_API_VERSION,
  FACEBOOK_AUTHORIZATION_ORIGIN,
  FACEBOOK_BUSINESS_DISCOVERY_SCOPE,
  FACEBOOK_CONFIGURED_SCOPES,
  FACEBOOK_GRAPH_ORIGIN,
  FACEBOOK_LIMITS,
  FACEBOOK_PUBLISHING_SCOPES,
  type FacebookRefreshSecret,
} from "./types";

const numericIdPattern = /^\d+$/;
const vanityHandlePattern = /^[A-Za-z0-9.]{1,255}$/;
const pageTaskPattern = /^[A-Z][A-Z0-9_]{0,127}$/;

const RESERVED_FACEBOOK_PATHS: Readonly<Record<string, true>> = {
  events: true,
  gaming: true,
  groups: true,
  help: true,
  marketplace: true,
  pages: true,
  people: true,
  privacy: true,
  "profile.php": true,
  settings: true,
  watch: true,
};

export interface FacebookOAuthConfig {
  clientId: string;
  clientSecret: string;
  configuredRedirectUri: string;
  http: ProviderHttpClient;
  now: () => Date;
}

/**
 * Identifies a malformed Facebook OAuth response field in existing warning logs.
 * Static field names preserve the shared transient classification. Optional
 * internal diagnostics contain only expiry facts, never credentials or bodies.
 */
function oauthMalformed(
  field:
    | "authorization_token"
    | "business_user_identity"
    | "business_user_list"
    | "long_lived_token"
    | "token_type"
    | "token_expiry"
    | "permissions"
    | "page_list"
    | "page_identity"
    | "page_access_token"
    | "page_tasks"
    | "page_pagination",
  cause?: Error,
): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({
      code: `facebook_oauth_${field}_invalid`,
      malformedResponse: true,
    }),
    cause ? { cause } : undefined,
  );
}

/**
 * Builds internal expiry evidence for OAuth warnings without retaining tokens,
 * app identities, or raw responses. Only finite numbers are rendered; all other
 * provider values appear as their type, so hostile strings cannot enter logs.
 */
function expiryDiagnostic(
  source: "exchange" | "debug_token",
  value: unknown,
  lifetime: unknown,
  valid?: boolean,
  appMatches?: boolean,
): Error {
  const numeric = (input: unknown): string =>
    typeof input === "number" && Number.isFinite(input)
      ? String(input)
      : input === null
        ? "null"
        : typeof input;
  return new Error(
    `Facebook OAuth expiry rejected: source=${source}, expiry=${numeric(value)}, lifetime_seconds=${numeric(lifetime)}, maximum_seconds=${FACEBOOK_LIMITS.tokenLifetimeMaxSeconds}` +
      (valid === undefined ? "" : `, token_valid=${valid}`) +
      (appMatches === undefined ? "" : `, app_matches=${appMatches}`),
  );
}

/**
 * Decodes and validates the composite Facebook refresh secret payload stored in database credentials.
 * Facebook Page access tokens require renewing a user token and refetching the Page token;
 * the refresh secret packages both `{ pageId, userAccessToken }` into JSON.
 */
function decodeRefreshSecret(value: string): FacebookRefreshSecret {
  const raw = required("refreshToken", value, OAUTH_TOKEN_MAX_CHARS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_refresh_secret_invalid",
        status: 400,
      }),
    );
  }
  const body = record(parsed);
  const pageId = providerIdentifier(body?.pageId);
  const userAccessToken = boundedString(body?.userAccessToken, FACEBOOK_LIMITS.tokenMaxChars);
  if (!body || Object.keys(body).length !== 2 || !pageId || !userAccessToken) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_refresh_secret_invalid",
        status: 400,
      }),
    );
  }
  return { pageId, userAccessToken };
}

/** Encodes a FacebookRefreshSecret object into JSON for encrypted credential storage. */
function encodeRefreshSecret(value: FacebookRefreshSecret): string {
  return JSON.stringify(value);
}

/**
 * Reads only explicitly granted permissions from Meta's permissions envelope.
 * Requested scopes are never evidence of consent, including during refresh.
 */
function grantedPermissions(value: unknown): string[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw oauthMalformed("permissions");
  const granted: string[] = [];
  for (const item of data) {
    const entry = record(item);
    const permission = boundedString(entry?.permission, 128);
    const status = boundedString(entry?.status, 32)?.toLowerCase();
    if (!permission || !status) throw oauthMalformed("permissions");
    if (status === "granted" && !granted.includes(permission)) granted.push(permission);
  }
  return granted;
}

/**
 * Extracts a legitimate vanity handle from a Facebook Page link URL.
 * Accepts only canonical facebook.com paths with a single non-reserved,
 * non-numeric segment so fake handles are never emitted.
 */
function facebookVanityHandle(link: unknown): string | undefined {
  if (typeof link !== "string" || !link) return undefined;
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (host !== "facebook.com" && !host.endsWith(".facebook.com")) {
      return undefined;
    }
    if (url.searchParams.has("id")) {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return undefined;
    }
    const candidate = segments[0];
    if (!candidate || numericIdPattern.test(candidate) || !vanityHandlePattern.test(candidate)) {
      return undefined;
    }
    if (RESERVED_FACEBOOK_PATHS[candidate.toLowerCase()]) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Extracts and validates the next pagination cursor from a Facebook Graph API
 * `paging` object, verifying both `cursors.after` and `next` origin/cursor
 * consistency and rejecting cycles against `seenCursors`.
 */
function nextFacebookPageCursor(
  pagingValue: unknown,
  seenCursors: Set<string>,
): string | undefined {
  if (pagingValue === undefined) return undefined;
  const paging = record(pagingValue);
  if (!paging) throw oauthMalformed("page_pagination");

  let cursorFromPaging: string | undefined;
  if (paging.cursors !== undefined) {
    const cursors = record(paging.cursors);
    if (!cursors) throw oauthMalformed("page_pagination");
    if (cursors.after !== undefined) {
      const validated = boundedCursor(cursors.after);
      if (!validated) throw oauthMalformed("page_pagination");
      cursorFromPaging = validated;
    }
  }

  if (paging.next === undefined) return undefined;
  if (typeof paging.next !== "string") throw oauthMalformed("page_pagination");

  let nextUrl: URL;
  try {
    nextUrl = new URL(paging.next);
  } catch {
    throw oauthMalformed("page_pagination");
  }
  if (nextUrl.origin !== FACEBOOK_GRAPH_ORIGIN) throw oauthMalformed("page_pagination");

  const rawAfterParam = nextUrl.searchParams.get("after");
  let cursorFromNextUrl: string | undefined;
  if (rawAfterParam !== null) {
    cursorFromNextUrl = boundedCursor(rawAfterParam);
    if (!cursorFromNextUrl) throw oauthMalformed("page_pagination");
  }
  if (
    cursorFromPaging !== undefined &&
    cursorFromNextUrl !== undefined &&
    cursorFromPaging !== cursorFromNextUrl
  ) {
    throw oauthMalformed("page_pagination");
  }
  const resolvedCursor = cursorFromPaging ?? cursorFromNextUrl;
  if (!resolvedCursor || seenCursors.has(resolvedCursor)) {
    throw oauthMalformed("page_pagination");
  }
  seenCursors.add(resolvedCursor);
  return resolvedCursor;
}

/**
 * Builds the Facebook OAuth handler methods (`authorizationUrl`,
 * `exchangeAuthorizationCode`, `refreshAccessToken`) sharing one long-lived
 * token exchange helper and Page discovery pipeline.
 */
export function createFacebookOAuth(config: FacebookOAuthConfig) {
  const { clientId, clientSecret, configuredRedirectUri, http, now } = config;

  /**
   * Exchanges a user token for a validated long-lived bearer token.
   * Missing expiry triggers same-app token inspection: a zero timestamp means
   * no time-based expiry, while a positive timestamp must be future and bounded.
   */
  const exchangeLongLived = async (
    context: ProviderRequestContext,
    currentToken: string,
  ): Promise<{ accessToken: string; expiresAt?: string }> => {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: required("userAccessToken", currentToken, FACEBOOK_LIMITS.tokenMaxChars),
      grant_type: "fb_exchange_token",
    });
    const response = await http.request<unknown>(context, {
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      url: `${FACEBOOK_GRAPH_ORIGIN}/${FACEBOOK_API_VERSION}/oauth/access_token`,
    });
    const body = record(response.body);
    const accessToken = boundedString(body?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
    const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
    if (!accessToken) throw oauthMalformed("long_lived_token");
    if (tokenType !== "bearer") throw oauthMalformed("token_type");
    let lifetime = body?.expires_in;
    let expirySource: "exchange" | "debug_token" = "exchange";
    let expiryValue: unknown = lifetime;
    let exchangedAt = now();
    if (lifetime === undefined) {
      const debugUrl = new URL(`/${FACEBOOK_API_VERSION}/debug_token`, FACEBOOK_GRAPH_ORIGIN);
      debugUrl.searchParams.set("input_token", accessToken);
      const inspected = await http.request<unknown>(context, {
        headers: bearer(`${clientId}|${clientSecret}`),
        method: "GET",
        url: debugUrl.toString(),
      });
      const data = record(record(inspected.body)?.data);
      expirySource = "debug_token";
      expiryValue = data?.expires_at;
      if (
        data?.is_valid !== true ||
        data.app_id !== clientId ||
        typeof data.expires_at !== "number" ||
        !Number.isSafeInteger(data.expires_at)
      ) {
        throw oauthMalformed(
          "token_expiry",
          expiryDiagnostic(
            expirySource,
            expiryValue,
            undefined,
            data?.is_valid === true,
            data?.app_id === clientId,
          ),
        );
      }
      if (data.expires_at === 0) return { accessToken };
      lifetime = data.expires_at - Math.floor(exchangedAt.getTime() / 1_000);
      exchangedAt = new Date(Math.floor(exchangedAt.getTime() / 1_000) * 1_000);
    }
    let expiresAt: string;
    try {
      expiresAt = addSeconds(exchangedAt, lifetime, FACEBOOK_LIMITS.tokenLifetimeMaxSeconds);
    } catch (cause) {
      if (cause instanceof ProviderAdapterError) {
        throw oauthMalformed("token_expiry", expiryDiagnostic(expirySource, expiryValue, lifetime));
      }
      throw cause;
    }
    return { accessToken, expiresAt };
  };

  return {
    /**
     * Builds the state-bound Facebook dialog URL for Page publishing and discovery.
     * `business_management` enables business-user Page assignments in addition to
     * directly managed Pages. Rejects callbacks that differ from configuration.
     */
    authorizationUrl(input: OAuthAuthorizationInput): string {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL(`/${FACEBOOK_API_VERSION}/dialog/oauth`, FACEBOOK_AUTHORIZATION_ORIGIN);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set(
        "scope",
        [...FACEBOOK_CONFIGURED_SCOPES, FACEBOOK_BUSINESS_DISCOVERY_SCOPE].join(","),
      );
      url.searchParams.set("state", required("state", input.state, OAUTH_STATE_MAX_CHARS));
      return url.toString();
    },

    /**
     * Exchanges the code and discovers publishable direct and business-assigned Pages.
     * Bounds Page records and requests to 1,000; runs up to four business-user edges
     * concurrently while preserving discovery order and deduplicating Page IDs.
     */
    async exchangeAuthorizationCode(
      context: ProviderRequestContext,
      input: OAuthExchangeInput,
    ): Promise<OAuthExchangeResult> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const shortBody = await exchangeAuthorizationCodeForm(http, context, {
        clientId,
        clientSecret,
        code: input.code,
        redirectUri: configuredRedirectUri,
        tokenUrl: `${FACEBOOK_GRAPH_ORIGIN}/${FACEBOOK_API_VERSION}/oauth/access_token`,
      });
      const shortToken = boundedString(
        record(shortBody)?.access_token,
        FACEBOOK_LIMITS.tokenMaxChars,
      );
      if (!shortToken) throw oauthMalformed("authorization_token");

      const longToken = await exchangeLongLived(context, shortToken);
      const permissionsUrl = new URL(
        `/${FACEBOOK_API_VERSION}/me/permissions`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      const permissionsResponse = await http.request<unknown>(context, {
        headers: bearer(longToken.accessToken),
        method: "GET",
        url: permissionsUrl.toString(),
      });
      const grantedScopes = grantedPermissions(permissionsResponse.body);
      if (!FACEBOOK_PUBLISHING_SCOPES.every((scope) => grantedScopes.includes(scope))) {
        return { accounts: [] };
      }

      const businessUsers = new Set<string>();
      const businessPaths: string[] = [];
      let discoveredCount = 0;
      let requestCount = 0;
      let failed = false;

      const discover = async (discoveryPath: string): Promise<OAuthConnection[]> => {
        const candidates: OAuthConnection[] = [];
        const pageIds = new Set<string>();
        const isBusinessUserList = discoveryPath === "me/business_users";
        const seenCursors = new Set<string>();
        let nextCursor: string | undefined;
        while (!failed) {
          if (requestCount >= 1_000) throw oauthMalformed("page_pagination");
          requestCount += 1;
          const pagesUrl = new URL(
            `/${FACEBOOK_API_VERSION}/${discoveryPath}`,
            FACEBOOK_GRAPH_ORIGIN,
          );
          pagesUrl.searchParams.set(
            "fields",
            isBusinessUserList ? "id" : "id,name,access_token,tasks,picture,link",
          );
          pagesUrl.searchParams.set("limit", "100");
          if (nextCursor !== undefined) pagesUrl.searchParams.set("after", nextCursor);

          const pagesResponse = await http.request<unknown>(context, {
            headers: bearer(longToken.accessToken),
            method: "GET",
            url: pagesUrl.toString(),
          });
          const pagesBody = record(pagesResponse.body);
          if (!Array.isArray(pagesBody?.data) || pagesBody.data.length > 100) {
            throw oauthMalformed("page_list");
          }

          if (!isBusinessUserList) {
            discoveredCount += pagesBody.data.length;
            if (discoveredCount > 1_000) throw oauthMalformed("page_list");
          }

          for (const value of pagesBody.data) {
            if (isBusinessUserList) {
              const id = providerIdentifier(record(value)?.id);
              if (!id) throw oauthMalformed("business_user_identity");
              if (!businessUsers.has(id)) {
                businessUsers.add(id);
                if (businessUsers.size > 1_000) throw oauthMalformed("business_user_list");
                businessPaths.push(`${id}/assigned_pages`);
              }
              continue;
            }
            const page = record(value);
            const id = providerIdentifier(page?.id);
            const displayName = boundedText(page?.name, 500);
            const accessToken = boundedString(page?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
            const tasks = page?.tasks;
            if (!id || !displayName) throw oauthMalformed("page_identity");
            if (!accessToken) throw oauthMalformed("page_access_token");
            if (
              !Array.isArray(tasks) ||
              tasks.length > 32 ||
              tasks.some((task) => typeof task !== "string" || !pageTaskPattern.test(task))
            ) {
              throw oauthMalformed("page_tasks");
            }
            if (pageIds.has(id)) continue;

            const picture = record(page?.picture);
            const pictureData = record(picture?.data);
            const rawAvatar =
              pictureData?.url ?? (typeof page?.picture === "string" ? page.picture : undefined);
            const avatarUrl = secureUrl(rawAvatar)?.href;
            const username = facebookVanityHandle(page?.link);

            if (tasks.includes("CREATE_CONTENT") || tasks.includes("PROFILE_PLUS_CREATE_CONTENT")) {
              pageIds.add(id);
              candidates.push({
                accessToken,
                account: {
                  ...(avatarUrl ? { avatarUrl } : {}),
                  displayName,
                  id,
                  ...(username ? { username } : {}),
                },
                ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
                refreshToken: encodeRefreshSecret({
                  pageId: id,
                  userAccessToken: longToken.accessToken,
                }),
                scopes: [...grantedScopes],
              });
            }
          }

          nextCursor = nextFacebookPageCursor(pagesBody.paging, seenCursors);
          if (nextCursor === undefined) break;
        }
        return candidates;
      };

      const eligible = await discover("me/accounts");
      if (grantedScopes.includes(FACEBOOK_BUSINESS_DISCOVERY_SCOPE)) {
        await discover("me/business_users");
      }
      const businessResults: OAuthConnection[][] = new Array(businessPaths.length);
      let nextEdge = 0;
      const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(4, businessPaths.length) }, async () => {
          while (!failed && nextEdge < businessPaths.length) {
            const index = nextEdge++;
            const path = businessPaths[index];
            if (!path) continue;
            try {
              businessResults[index] = await discover(path);
            } catch (cause) {
              failed = true;
              throw cause;
            }
          }
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      const identifiers = new Set(eligible.map((connection) => connection.account.id));
      for (const candidates of businessResults) {
        for (const candidate of candidates) {
          if (identifiers.has(candidate.account.id)) continue;
          identifiers.add(candidate.account.id);
          eligible.push(candidate);
        }
      }
      return { accounts: eligible };
    },

    /**
     * Rotates the user token and derives a token for the same Page.
     * Preserves absent expiry for inspected zero-expiry tokens; Page identity
     * and grants are re-read from Meta rather than assumed.
     */
    async refreshAccessToken(
      context: ProviderRequestContext,
      value: string,
    ): Promise<ProviderTokenSet> {
      const current = decodeRefreshSecret(value);
      const longToken = await exchangeLongLived(context, current.userAccessToken);
      const pageUrl = new URL(
        `/${FACEBOOK_API_VERSION}/${encodeURIComponent(current.pageId)}`,
        FACEBOOK_GRAPH_ORIGIN,
      );
      pageUrl.searchParams.set("fields", "id,name,access_token");
      const pageResponse = await http.request<unknown>(context, {
        headers: bearer(longToken.accessToken),
        method: "GET",
        url: pageUrl.toString(),
      });
      const page = record(pageResponse.body);
      const id = providerIdentifier(page?.id);
      const accessToken = boundedString(page?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
      if (id !== current.pageId || !accessToken) throw malformed();
      const permissions = await http.request<unknown>(context, {
        headers: bearer(longToken.accessToken),
        method: "GET",
        url: new URL(`/${FACEBOOK_API_VERSION}/me/permissions`, FACEBOOK_GRAPH_ORIGIN).toString(),
      });
      return {
        accessToken,
        ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
        refreshToken: encodeRefreshSecret({
          pageId: current.pageId,
          userAccessToken: longToken.accessToken,
        }),
        scopes: grantedPermissions(permissions.body),
      };
    },
  };
}
