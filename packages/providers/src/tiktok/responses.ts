import { malformed, ProviderAdapterError, rejected, rejection } from "../failures";
import { PROVIDER_LIMITS } from "../limits";
import { addSeconds } from "../oauth";
import { confirmedFailure } from "../results";
import type {
  OAuthConnection,
  ProviderCredentials,
  ProviderPublicationStatus,
  TikTokPrivacyLevel,
  TikTokPublicationRequirements,
} from "../types";
import { boundedString, boundedText, metricValue, optionalSecureUrl, record } from "../values";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,254}$/;
const openIdPattern = /^[A-Za-z0-9_-][A-Za-z0-9._:~-]{0,254}$/;
const errorCodePattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const scopePattern = /^[a-z][a-z0-9._-]{0,99}$/;
const operationPattern = /^(publish|inbox):(.+)$/;
const maxScopes = 20;

const limits = PROVIDER_LIMITS.tiktok;
const authErrorCodes = ["access_token_invalid", "scope_not_authorized", "token_not_authorized"];
const retryableFailReasons = ["internal", "video_pull_failed", "photo_pull_failed"];
const processingStatuses = ["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"];
const requiredScopes = ["user.info.basic"] as const;
const privacyLevels: ReadonlySet<string> = new Set<TikTokPrivacyLevel>([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

export interface TikTokTokenBody {
  accessToken: string;
  expiresAt: string;
  openId: string;
  refreshToken: string;
  scope: { kind: "absent" } | { kind: "invalid" } | { kind: "granted"; scopes: string[] };
}

export interface TikTokOperation {
  inbox: boolean;
  publishId: string;
}

export function isPrivacyLevel(value: unknown): value is TikTokPrivacyLevel {
  return typeof value === "string" && privacyLevels.has(value);
}

export function patternIdentifier(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return pattern.test(normalized) ? normalized : undefined;
}

export const tiktokIdentifier = (value: unknown) => patternIdentifier(value, identifierPattern);
export const openId = (value: unknown) => patternIdentifier(value, openIdPattern);

export function accountId(credentials: ProviderCredentials): string {
  const value = openId(credentials.accountId);
  if (!value) throw rejected("tiktok_account_required");
  return value;
}

export function apiFailureStatus(code: string): number {
  if (authErrorCodes.includes(code)) return 401;
  if (code.includes("rate_limit")) return 429;
  if (
    code.includes("active_user_cap") ||
    code.includes("too_many_posts") ||
    code.includes("quota")
  ) {
    return 507;
  }
  if (code.includes("internal") || code.includes("server")) return 503;
  return 400;
}

export function apiError(code: string): ProviderAdapterError {
  const normalized = code.trim().toLowerCase();
  if (!errorCodePattern.test(normalized)) throw malformed();
  return rejected(`tiktok_${normalized}`, apiFailureStatus(normalized));
}

export function envelope(value: unknown, sideEffectPossible = false): Record<string, unknown> {
  const body = record(value);
  const code = boundedString(record(body?.error)?.code, 80);
  if (!body || !code) throw malformed(sideEffectPossible);
  if (code !== "ok") throw apiError(code);
  const data = record(body.data);
  if (!data) throw malformed(sideEffectPossible);
  return data;
}

export function scopeSet(value: unknown): string[] | undefined {
  const scopes = boundedString(value, 4_096)
    ?.split(",")
    .map((scope) => scope.trim());
  return scopes &&
    scopes.length <= maxScopes &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => scopePattern.test(scope))
    ? scopes
    : undefined;
}

export function tokenBody(value: unknown, now: Date): TikTokTokenBody {
  const body = record(value);
  const providerError = boundedString(body?.error, 80);
  if (providerError) throw apiError(providerError);
  const accessToken = boundedString(body?.access_token, limits.tokenMaxChars);
  const refreshToken = boundedString(body?.refresh_token, limits.tokenMaxChars);
  const tokenOpenId = openId(body?.open_id);
  const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
  if (
    !accessToken ||
    !refreshToken ||
    !tokenOpenId ||
    (tokenType !== undefined && tokenType !== "bearer")
  ) {
    throw malformed(false, "tiktok_token_response_invalid");
  }
  const scopes = scopeSet(body?.scope);
  return {
    accessToken,
    expiresAt: addSeconds(now, body?.expires_in, limits.tokenLifetimeMaxSeconds),
    openId: tokenOpenId,
    refreshToken,
    scope:
      body?.scope === undefined
        ? { kind: "absent" }
        : scopes
          ? { kind: "granted", scopes }
          : { kind: "invalid" },
  };
}

export function publishingGrant(scope: TikTokTokenBody["scope"]): string[] {
  if (scope.kind === "invalid") throw malformed(false, "tiktok_token_response_invalid");
  const granted = scope.kind === "granted" ? scope.scopes : [];
  const missingScopes: string[] = requiredScopes.filter((name) => !granted.includes(name));
  if (!granted.includes("video.publish") && !granted.includes("video.upload")) {
    missingScopes.push("video.publish");
  }
  if (missingScopes.length > 0) {
    throw new ProviderAdapterError(rejection("tiktok_scope_not_granted"), { missingScopes });
  }
  return granted;
}

export function creatorRequirements(value: unknown): TikTokPublicationRequirements {
  const data = envelope(value);
  const avatar = optionalSecureUrl(data.creator_avatar_url);
  const creatorUsername = boundedText(data.creator_username, 255);
  const creatorDisplayName = boundedText(data.creator_nickname, 500);
  const rawPrivacyLevels = data.privacy_level_options;
  const maxVideoDurationSeconds = data.max_video_post_duration_sec;
  if (
    !avatar.valid ||
    !creatorUsername ||
    !creatorDisplayName ||
    !Array.isArray(rawPrivacyLevels) ||
    rawPrivacyLevels.length < 1 ||
    new Set(rawPrivacyLevels).size !== rawPrivacyLevels.length ||
    !rawPrivacyLevels.every(isPrivacyLevel) ||
    typeof data.comment_disabled !== "boolean" ||
    typeof data.duet_disabled !== "boolean" ||
    typeof data.stitch_disabled !== "boolean" ||
    typeof maxVideoDurationSeconds !== "number" ||
    !Number.isInteger(maxVideoDurationSeconds) ||
    maxVideoDurationSeconds < 1 ||
    maxVideoDurationSeconds > limits.maxVideoDurationSeconds
  ) {
    throw malformed();
  }
  return {
    commentAllowed: !data.comment_disabled,
    ...(avatar.href ? { creatorAvatarUrl: avatar.href } : {}),
    creatorDisplayName,
    creatorUsername,
    duetAllowed: !data.duet_disabled,
    maxVideoDurationSeconds,
    platform: "tiktok",
    privacyLevels: rawPrivacyLevels,
    stitchAllowed: !data.stitch_disabled,
  };
}

export function operationId(operation: TikTokOperation): string {
  return `${operation.inbox ? "inbox" : "publish"}:${operation.publishId}`;
}

export function parseOperationId(value: unknown): TikTokOperation | undefined {
  const match = tiktokIdentifier(value)?.match(operationPattern);
  const publishId = tiktokIdentifier(match?.[2]);
  return match && publishId ? { inbox: match[1] === "inbox", publishId } : undefined;
}

export function requiredOperation(value: unknown): TikTokOperation {
  const operation = parseOperationId(value);
  if (!operation) throw rejected("tiktok_publish_id_required");
  return operation;
}

export function failedPublishCode(reason: string | undefined): { code: string; status: number } {
  return {
    code: reason && errorCodePattern.test(reason) ? `tiktok_${reason}` : "tiktok_publish_failed",
    status: retryableFailReasons.includes(reason ?? "")
      ? 503
      : reason === "auth_removed"
        ? 401
        : 422,
  };
}

export function tiktokAccount(
  user: Record<string, unknown> | undefined,
  tokenOpenId: string,
): OAuthConnection["account"] {
  const displayName = boundedText(user?.display_name, 500);
  const avatar = optionalSecureUrl(user?.avatar_url);
  const username = boundedString(user?.username, 255);
  if (openId(user?.open_id) !== tokenOpenId || !displayName || !avatar.valid) {
    throw malformed();
  }
  return {
    ...(avatar.href ? { avatarUrl: avatar.href } : {}),
    displayName,
    id: tokenOpenId,
    ...(username ? { username } : {}),
  };
}

export function tiktokAccountCounts(user: Record<string, unknown> | undefined) {
  const followers = metricValue(user?.follower_count);
  const following = metricValue(user?.following_count);
  const posts = metricValue(user?.video_count);
  if (followers === undefined) throw malformed();
  return {
    followers,
    ...(following === undefined ? {} : { following }),
    ...(posts === undefined ? {} : { posts }),
  };
}

export function tiktokVideoCounts(responseBody: unknown, providerPostId: string) {
  const videos = envelope(responseBody).videos;
  if (!Array.isArray(videos) || videos.length > 1) throw malformed();
  if (videos.length === 0) return undefined;
  const video = record(videos[0]);
  const views = metricValue(video?.view_count);
  const likes = metricValue(video?.like_count);
  const comments = metricValue(video?.comment_count);
  const shares = metricValue(video?.share_count);
  if (
    tiktokIdentifier(video?.id) !== providerPostId ||
    views === undefined ||
    likes === undefined ||
    comments === undefined ||
    shares === undefined
  ) {
    throw malformed();
  }
  return { comments, likes, shares, views };
}

export function tiktokPublicationStatus(
  responseBody: unknown,
  operation: TikTokOperation,
): ProviderPublicationStatus {
  const retainedOperationId = operationId(operation);
  if (record(record(responseBody)?.error)?.code === "invalid_publish_id") {
    return { state: "not_found" };
  }
  const data = envelope(responseBody);
  const status = boundedString(data.status, 64);
  if (status && processingStatuses.includes(status)) {
    return { providerOperationId: retainedOperationId, state: "processing" };
  }
  if (status === "SEND_TO_USER_INBOX") {
    return operation.inbox
      ? {
          state: "delivered",
          result: {
            outcome: "confirmed_success",
            delivery: "inbox",
            providerOperationId: retainedOperationId,
          },
        }
      : {
          result: confirmedFailure(rejection("tiktok_sent_to_inbox", 422), retainedOperationId),
          state: "failed",
        };
  }
  if (status === "FAILED") {
    const { code, status: failureStatus } = failedPublishCode(
      boundedString(data.fail_reason, 80)?.toLowerCase(),
    );
    return {
      result: confirmedFailure(rejection(code, failureStatus), retainedOperationId),
      state: "failed",
    };
  }
  if (status !== "PUBLISH_COMPLETE") throw malformed();
  const rawPostIds = data.publicaly_available_post_id;
  const postIds = Array.isArray(rawPostIds)
    ? rawPostIds.map((id: unknown) =>
        tiktokIdentifier(
          typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : id,
        ),
      )
    : undefined;
  if (rawPostIds !== undefined && (!postIds || postIds.some((id) => !id))) throw malformed();
  const providerPostId = postIds?.[0];
  return {
    result: {
      outcome: "confirmed_success",
      providerOperationId: retainedOperationId,
      ...(providerPostId ? { providerPostId } : {}),
    },
    state: "published",
  };
}
