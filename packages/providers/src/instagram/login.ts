import { malformed } from "../failures";
import type { OAuthConnection } from "../types";
import {
  boundedString,
  boundedText,
  optionalSecureUrl,
  providerIdentifier,
  record,
} from "../values";

const professionalAccountTypes = ["BUSINESS", "MEDIA_CREATOR"];
const maxGrantedPermissions = 32;

export function instagramLoginRecord(value: unknown): Record<string, unknown> {
  const body = record(value);
  if (!body) throw malformed();
  if (body.data === undefined) return body;
  if (!Array.isArray(body.data) || body.data.length !== 1) throw malformed();
  const account = record(body.data[0]);
  if (!account) throw malformed();
  return account;
}

export function instagramGrantedPermissions(value: unknown): (string | undefined)[] | undefined {
  if (Array.isArray(value)) {
    return value.length <= maxGrantedPermissions
      ? value.map((scope: unknown) => boundedString(scope, 128))
      : undefined;
  }
  return boundedString(value, 4_096)
    ?.split(",")
    .map((scope) => scope.trim());
}

export function instagramAccount(profile: Record<string, unknown>): OAuthConnection["account"] {
  const profileAccountId = providerIdentifier(profile.user_id);
  const username = boundedString(profile.username, 255);
  const displayName = boundedText(profile.name, 500) ?? username;
  const avatar = optionalSecureUrl(profile.profile_picture_url);
  if (
    !providerIdentifier(profile.id) ||
    !profileAccountId ||
    !username ||
    !displayName ||
    !professionalAccountTypes.includes(String(profile.account_type).toUpperCase()) ||
    !avatar.valid
  ) {
    throw malformed();
  }
  return {
    ...(avatar.href ? { avatarUrl: avatar.href } : {}),
    displayName,
    id: profileAccountId,
    username,
  };
}
