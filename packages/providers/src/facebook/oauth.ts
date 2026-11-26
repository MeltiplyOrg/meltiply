import { classifyProviderFailure, malformed, ProviderAdapterError, rejected } from "../failures";
import { OAUTH_TOKEN_MAX_CHARS } from "../limits";
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
import {
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  providerIdentifier,
  record,
  required,
  secureUrl,
} from "../values";
import {
  FACEBOOK_BUSINESS_DISCOVERY_SCOPE,
  FACEBOOK_CONFIGURED_SCOPES,
  FACEBOOK_GRAPH_ORIGIN,
  FACEBOOK_LIMITS,
  FACEBOOK_PUBLISHING_SCOPES,
  graphUrl,
  nodeUrl,
  type FacebookRefreshSecret,
} from "./types";

const numericIdPattern = /^\d+$/;
const vanityHandlePattern = /^[A-Za-z0-9.]{1,255}$/;
const pageTaskPattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const reservedPaths = new Set([
  "events",
  "gaming",
  "groups",
  "help",
  "marketplace",
  "pages",
  "people",
  "privacy",
  "profile.php",
  "settings",
  "watch",
]);
const contentTasks = ["CREATE_CONTENT", "PROFILE_PLUS_CREATE_CONTENT"];
const discoveryPageSize = 100;
const maxDiscoveredPages = 1_000;
const maxBusinessUsers = 1_000;
const maxPageTasks = 32;
const businessEdgeConcurrency = 4;
const businessUsersPath = "me/business_users";

type OAuthField =
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
  | "page_pagination";

function oauthMalformed(field: OAuthField, cause?: Error): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({ code: `facebook_oauth_${field}_invalid`, malformedResponse: true }),
    cause ? { cause } : undefined,
  );
}

function expiryDiagnostic(
  source: "exchange" | "debug_token",
  facts: Readonly<Record<string, unknown>>,
): Error {
  const rendered = Object.entries(facts)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const shown =
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean" ||
        value === null
          ? String(value)
          : typeof value;
      return `${name}=${shown}`;
    });
  return new Error(
    `Facebook OAuth expiry rejected: ${[`source=${source}`, ...rendered, `maximum_seconds=${FACEBOOK_LIMITS.tokenLifetimeMaxSeconds}`].join(", ")}`,
  );
}

function decodeRefreshSecret(value: string): FacebookRefreshSecret {
  const raw = required("refreshToken", value, OAUTH_TOKEN_MAX_CHARS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw rejected("facebook_refresh_secret_invalid");
  }
  const body = record(parsed);
  const pageId = providerIdentifier(body?.pageId);
  const userAccessToken = boundedString(body?.userAccessToken, FACEBOOK_LIMITS.tokenMaxChars);
  if (!body || Object.keys(body).length !== 2 || !pageId || !userAccessToken) {
    throw rejected("facebook_refresh_secret_invalid");
  }
  return { pageId, userAccessToken };
}

function encodeRefreshSecret(value: FacebookRefreshSecret): string {
  return JSON.stringify(value);
}

function grantedPermissions(value: unknown): string[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw oauthMalformed("permissions");
  const granted = new Set<string>();
  for (const item of data) {
    const entry = record(item);
    const permission = boundedString(entry?.permission, 128);
    const status = boundedString(entry?.status, 32)?.toLowerCase();
    if (!permission || !status) throw oauthMalformed("permissions");
    if (status === "granted") granted.add(permission);
  }
  return [...granted];
}

function facebookVanityHandle(link: unknown): string | undefined {
  if (typeof link !== "string" || !URL.canParse(link)) return undefined;
  const url = new URL(link);
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const [candidate] = segments;
  if (
    (host !== "facebook.com" && !host.endsWith(".facebook.com")) ||
    url.searchParams.has("id") ||
    segments.length !== 1 ||
    !candidate ||
    numericIdPattern.test(candidate) ||
    !vanityHandlePattern.test(candidate) ||
    reservedPaths.has(candidate.toLowerCase())
  ) {
    return undefined;
  }
  return candidate;
}

function nextPageCursor(pagingValue: unknown, seenCursors: Set<string>): string | undefined {
  if (pagingValue === undefined) return undefined;
  const paging = record(pagingValue);
  const cursors = paging?.cursors === undefined ? {} : record(paging.cursors);
  if (!paging || !cursors) throw oauthMalformed("page_pagination");
  const cursorFromPaging =
    cursors.after === undefined ? undefined : (boundedCursor(cursors.after) ?? null);
  if (cursorFromPaging === null) throw oauthMalformed("page_pagination");
  if (paging.next === undefined) return undefined;
  if (typeof paging.next !== "string" || !URL.canParse(paging.next)) {
    throw oauthMalformed("page_pagination");
  }
  const nextUrl = new URL(paging.next);
  const rawAfter = nextUrl.searchParams.get("after");
  const cursorFromNext = rawAfter === null ? undefined : boundedCursor(rawAfter);
  const cursor = cursorFromPaging ?? cursorFromNext;
  if (
    nextUrl.origin !== FACEBOOK_GRAPH_ORIGIN ||
    (rawAfter !== null && !cursorFromNext) ||
    (cursorFromPaging !== undefined &&
      cursorFromNext !== undefined &&
      cursorFromPaging !== cursorFromNext) ||
    !cursor ||
    seenCursors.has(cursor)
  ) {
    throw oauthMalformed("page_pagination");
  }
  seenCursors.add(cursor);
  return cursor;
}

function parsePageTasks(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxPageTasks ||
    value.some((task) => typeof task !== "string" || !pageTaskPattern.test(task))
  ) {
    throw oauthMalformed("page_tasks");
  }
  return value;
}

export function discoveryRequestLimit(override: number | undefined): number {
  return override ?? 1_000;
}

export function createFacebookOAuth(runtime: AdapterRuntime, maxDiscoveryRequests: number) {
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
    let lifetime = body?.expires_in;
    let exchangedAt = now();
    let source: "exchange" | "debug_token" = "exchange";
    let evidence: Record<string, unknown> = { expiry: lifetime };
    if (lifetime === undefined) {
      const debugUrl = graphUrl("debug_token");
      debugUrl.searchParams.set("input_token", accessToken);
      const data = record(
        record(await getGraph(context, `${clientId}|${clientSecret}`, debugUrl))?.data,
      );
      source = "debug_token";
      evidence = {
        expiry: data?.expires_at,
        token_valid: data?.is_valid === true,
        app_matches: data?.app_id === clientId,
      };
      if (
        data?.is_valid !== true ||
        data.app_id !== clientId ||
        typeof data.expires_at !== "number" ||
        !Number.isSafeInteger(data.expires_at)
      ) {
        throw oauthMalformed("token_expiry", expiryDiagnostic(source, evidence));
      }
      if (data.expires_at === 0) return { accessToken };
      const exchangedSeconds = Math.floor(exchangedAt.getTime() / 1_000);
      lifetime = data.expires_at - exchangedSeconds;
      exchangedAt = new Date(exchangedSeconds * 1_000);
    }
    try {
      return {
        accessToken,
        expiresAt: addSeconds(exchangedAt, lifetime, FACEBOOK_LIMITS.tokenLifetimeMaxSeconds),
      };
    } catch {
      throw oauthMalformed(
        "token_expiry",
        expiryDiagnostic(source, { ...evidence, lifetime_seconds: lifetime }),
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

      const pageConnection = (value: unknown): OAuthConnection | undefined => {
        const page = record(value);
        const id = providerIdentifier(page?.id);
        const displayName = boundedText(page?.name, 500);
        const accessToken = boundedString(page?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
        if (!id || !displayName) throw oauthMalformed("page_identity");
        if (!accessToken) throw oauthMalformed("page_access_token");
        const tasks = parsePageTasks(page?.tasks);
        if (!tasks.some((task) => contentTasks.includes(task))) return undefined;
        const avatarUrl = secureUrl(
          record(record(page?.picture)?.data)?.url ??
            (typeof page?.picture === "string" ? page.picture : undefined),
        )?.href;
        const username = facebookVanityHandle(page?.link);
        return {
          accessToken,
          account: {
            ...(avatarUrl ? { avatarUrl } : {}),
            displayName,
            id,
            ...(username ? { username } : {}),
          },
          ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
          refreshToken: encodeRefreshSecret({ pageId: id, userAccessToken: longToken.accessToken }),
          scopes: [...grantedScopes],
        };
      };

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
              const connection = pageConnection(value);
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
