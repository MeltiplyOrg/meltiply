import { malformed } from "../failures";
import { insightValue } from "../meta";
import type { OAuthConnection } from "../types";
import {
  boundedString,
  boundedText,
  optionalSecureUrl,
  providerIdentifier,
  record,
} from "../values";

const scopePattern = /^[a-z_]+$/;

export function threadsGrantedScopes(responseBody: unknown, expectedAccount?: string): string[] {
  const data = record(record(responseBody)?.data);
  const rawScopes = data?.scopes;
  if (
    data?.is_valid !== true ||
    !providerIdentifier(data.user_id) ||
    (expectedAccount && data.user_id !== expectedAccount) ||
    !Array.isArray(rawScopes) ||
    rawScopes.some((scope) => typeof scope !== "string" || !scopePattern.test(scope))
  ) {
    throw malformed();
  }
  return [...new Set<string>(rawScopes)];
}

export function threadsAccount(responseBody: unknown): OAuthConnection["account"] & { id: string } {
  const profile = record(responseBody);
  const accountId = providerIdentifier(profile?.id);
  const username = boundedString(profile?.username, 255);
  const displayName = boundedText(profile?.name, 500) ?? username;
  const avatar = optionalSecureUrl(profile?.threads_profile_picture_url);
  if (!accountId || !username || !displayName || !avatar.valid) throw malformed();
  return {
    ...(avatar.href ? { avatarUrl: avatar.href } : {}),
    displayName,
    id: accountId,
    username,
  };
}

export function threadsEngagement(metrics: ReadonlyMap<string, number>) {
  return {
    comments: metrics.get("replies") ?? 0,
    likes: metrics.get("likes") ?? 0,
    shares:
      (metrics.get("shares") ?? 0) + (metrics.get("reposts") ?? 0) + (metrics.get("quotes") ?? 0),
    views: metrics.get("views") ?? 0,
  };
}

export function threadsFollowers(responseBody: unknown): number {
  const data = record(responseBody)?.data;
  if (!Array.isArray(data)) throw malformed();
  const metric = data.map(record).find((item) => item?.name === "followers_count");
  const followers = metric ? insightValue(metric) : undefined;
  if (followers === undefined) throw malformed();
  return followers;
}

export function confirmsThreadsDeletion(
  body: Record<string, unknown> | undefined,
  providerPostId: string,
): boolean {
  return (
    body?.success === true &&
    (body.deleted_id === undefined || providerIdentifier(body.deleted_id) === providerPostId)
  );
}
