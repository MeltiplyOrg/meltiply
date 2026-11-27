import { describe, expect, it } from "vite-plus/test";

import { ProviderAdapterError } from "../src/failures";
import {
  accountId,
  creatorRequirements,
  envelope,
  operationId,
  publishingGrant,
  requiredOperation,
  tiktokAccount,
  tiktokAccountCounts,
  tiktokPublicationStatus,
  tiktokVideoCounts,
  tokenBody,
} from "../src/tiktok/responses";
import {
  failureThrownBy,
  malformedAnswer,
  providerFailure,
  refused,
  unconfirmed,
  thrownBy,
} from "./support";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const ok = (data: object) => ({ data, error: { code: "ok" } });
const token = {
  access_token: "a",
  refresh_token: "r",
  open_id: "o1",
  expires_in: 3_600,
  scope: "user.info.basic, video.publish",
  token_type: "Bearer",
};
const parsed = {
  accessToken: "a",
  expiresAt: "2026-07-19T01:00:00.000Z",
  openId: "o1",
  refreshToken: "r",
  scope: { kind: "granted", scopes: ["user.info.basic", "video.publish"] },
};
const creator = {
  creator_username: "u",
  creator_nickname: "N",
  privacy_level_options: ["SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

describe("envelope", () => {
  it("a successful body", () => {
    expect(envelope(ok({ a: 1 }))).toEqual({ a: 1 });
  });

  it.each([
    [
      "an expired token",
      "access_token_invalid",
      providerFailure("auth", "tiktok_access_token_invalid"),
    ],
    [
      "a rate limit",
      "rate_limit_exceeded",
      providerFailure("rate_limit", "tiktok_rate_limit_exceeded"),
    ],
    [
      "a posting cap",
      "spam_risk_too_many_posts",
      providerFailure("quota", "tiktok_spam_risk_too_many_posts"),
    ],
    ["a server error", "internal_error", providerFailure("transient", "tiktok_internal_error")],
    ["a rejection", "Invalid_Params", refused("tiktok_invalid_params")],
    ["an unusable code", "bad code!", malformedAnswer],
  ])("%s", (_example, code, failure) => {
    expect(failureThrownBy(() => envelope({ error: { code } }))).toEqual(failure);
  });

  it.each([
    ["no error block", { data: {} }, false, malformedAnswer],
    ["no data", { error: { code: "ok" } }, false, malformedAnswer],
    ["no data after a write", { error: { code: "ok" } }, true, unconfirmed],
  ])("%s", (_example, body, sideEffectPossible, failure) => {
    expect(failureThrownBy(() => envelope(body, sideEffectPossible))).toEqual(failure);
  });
});

describe("tokenBody", () => {
  it("a complete token", () => {
    expect(tokenBody(token, NOW)).toEqual(parsed);
  });

  it.each([
    ["no scope", undefined, { kind: "absent" }],
    ["a repeated scope", "a,a", { kind: "invalid" }],
    ["a scope that is not a name", "A B", { kind: "invalid" }],
  ])("%s", (_example, scope, expected) => {
    expect(tokenBody({ ...token, scope }, NOW)).toEqual({ ...parsed, scope: expected });
  });

  it("a provider error", () => {
    expect(failureThrownBy(() => tokenBody({ error: "invalid_grant" }, NOW))).toEqual(
      refused("tiktok_invalid_grant"),
    );
  });

  it.each([
    ["no access token", { access_token: "" }],
    ["no refresh token", { refresh_token: undefined }],
    ["no open ID", { open_id: undefined }],
    ["another token type", { token_type: "mac" }],
  ])("%s", (_example, patch) => {
    expect(failureThrownBy(() => tokenBody({ ...token, ...patch }, NOW))).toEqual(
      providerFailure("transient", "tiktok_token_response_invalid"),
    );
  });

  it("a lifetime over two days", () => {
    expect(failureThrownBy(() => tokenBody({ ...token, expires_in: 172_801 }, NOW))).toEqual(
      malformedAnswer,
    );
  });
});

describe("publishingGrant", () => {
  const granted = (...scopes: string[]) => ({ kind: "granted" as const, scopes });

  it.each([
    ["direct publishing", ["user.info.basic", "video.publish"]],
    ["inbox upload only", ["user.info.basic", "video.upload"]],
  ])("%s", (_example, scopes) => {
    expect(publishingGrant(granted(...scopes))).toEqual(scopes);
  });

  it.each([
    ["no profile access", granted("video.publish"), ["user.info.basic"]],
    ["no way to publish", granted("user.info.basic"), ["video.publish"]],
    ["no scope at all", { kind: "absent" as const }, ["user.info.basic", "video.publish"]],
  ])("%s", (_example, scope, missingScopes) => {
    expect(thrownBy(() => publishingGrant(scope))).toEqual(
      new ProviderAdapterError(refused("tiktok_scope_not_granted"), { missingScopes }),
    );
  });

  it("an unusable scope list", () => {
    expect(failureThrownBy(() => publishingGrant({ kind: "invalid" }))).toEqual(
      providerFailure("transient", "tiktok_token_response_invalid"),
    );
  });
});

describe("creatorRequirements", () => {
  const requirements = {
    commentAllowed: true,
    creatorDisplayName: "N",
    creatorUsername: "u",
    duetAllowed: false,
    maxVideoDurationSeconds: 600,
    platform: "tiktok",
    privacyLevels: ["SELF_ONLY"],
    stitchAllowed: true,
  };

  it("a creator without a picture", () => {
    expect(creatorRequirements(ok(creator))).toEqual(requirements);
  });

  it("a creator with a picture", () => {
    expect(creatorRequirements(ok({ ...creator, creator_avatar_url: "https://c.test/a" }))).toEqual(
      {
        ...requirements,
        creatorAvatarUrl: "https://c.test/a",
      },
    );
  });

  it.each([
    ["an insecure picture", { creator_avatar_url: "http://c.test" }],
    ["no username", { creator_username: "" }],
    ["no display name", { creator_nickname: "" }],
    ["no privacy level", { privacy_level_options: [] }],
    ["a repeated privacy level", { privacy_level_options: ["SELF_ONLY", "SELF_ONLY"] }],
    ["an unknown privacy level", { privacy_level_options: ["FRIENDS"] }],
    ["a comment flag that is not boolean", { comment_disabled: "no" }],
    ["no duet flag", { duet_disabled: undefined }],
    ["no stitch flag", { stitch_disabled: undefined }],
    ["no duration", { max_video_post_duration_sec: 0 }],
    ["a duration over ten minutes", { max_video_post_duration_sec: 601 }],
  ])("refuses %s", (_example, patch) => {
    expect(failureThrownBy(() => creatorRequirements(ok({ ...creator, ...patch })))).toEqual(
      malformedAnswer,
    );
  });
});

describe("accountId", () => {
  it("a bound open ID", () => {
    expect(accountId({ accessToken: "a", accountId: "-o_1" })).toEqual("-o_1");
  });

  it("no account", () => {
    expect(failureThrownBy(() => accountId({ accessToken: "a" }))).toEqual(
      refused("tiktok_account_required"),
    );
  });
});

describe("operationId", () => {
  it.each([
    [false, "publish:v_1"],
    [true, "inbox:v_1"],
  ])("inbox %s", (inbox, expected) => {
    expect(operationId({ inbox, publishId: "v_1" })).toEqual(expected);
  });
});

describe("requiredOperation", () => {
  it("an inbox operation", () => {
    expect(requiredOperation("inbox:v_1")).toEqual({ inbox: true, publishId: "v_1" });
  });

  it.each([undefined, "other:v_1", "publish:"])("%s is refused", (value) => {
    expect(failureThrownBy(() => requiredOperation(value))).toEqual(
      refused("tiktok_publish_id_required"),
    );
  });
});

describe("tiktokAccount", () => {
  const user = { open_id: "o1", display_name: "N" };

  it("a user with a username and picture", () => {
    expect(tiktokAccount({ ...user, username: "u", avatar_url: "https://c.test/a" }, "o1")).toEqual(
      { avatarUrl: "https://c.test/a", displayName: "N", id: "o1", username: "u" },
    );
  });

  it("a user without either", () => {
    expect(tiktokAccount(user, "o1")).toEqual({ displayName: "N", id: "o1" });
  });

  it.each([
    ["another user", { ...user, open_id: "o2" }],
    ["no display name", { open_id: "o1" }],
    ["an insecure picture", { ...user, avatar_url: "http://c.test" }],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => tiktokAccount(value, "o1"))).toEqual(malformedAnswer);
  });
});

describe("tiktokAccountCounts", () => {
  it.each([
    [
      "every count",
      { follower_count: 0, following_count: 2, video_count: 3 },
      { followers: 0, following: 2, posts: 3 },
    ],
    ["followers only", { follower_count: 5 }, { followers: 5 }],
  ])("%s", (_example, user, counts) => {
    expect(tiktokAccountCounts(user)).toEqual(counts);
  });

  it("no follower count", () => {
    expect(failureThrownBy(() => tiktokAccountCounts({}))).toEqual(malformedAnswer);
  });
});

describe("tiktokVideoCounts", () => {
  const video = { id: "v1", view_count: 1, like_count: 2, comment_count: 3, share_count: 4 };

  it("a found video", () => {
    expect(tiktokVideoCounts(ok({ videos: [video] }), "v1")).toEqual({
      comments: 3,
      likes: 2,
      shares: 4,
      views: 1,
    });
  });

  it("no video", () => {
    expect(tiktokVideoCounts(ok({ videos: [] }), "v1")).toEqual(undefined);
  });

  it.each([
    ["no list", {}],
    ["two videos", { videos: [video, video] }],
    ["another video", { videos: [{ ...video, id: "v2" }] }],
    ["a missing count", { videos: [{ ...video, share_count: undefined }] }],
  ])("refuses %s", (_example, data) => {
    expect(failureThrownBy(() => tiktokVideoCounts(ok(data), "v1"))).toEqual(malformedAnswer);
  });
});

describe("tiktokPublicationStatus", () => {
  const direct = { inbox: false, publishId: "v1" };
  const inbox = { inbox: true, publishId: "v1" };
  const failed = (failure: object, id = "publish:v1") => ({
    result: { failure, outcome: "confirmed_failure", providerOperationId: id },
    state: "failed",
  });

  it.each([
    [
      "an unknown publish ID",
      { error: { code: "invalid_publish_id" } },
      direct,
      { state: "not_found" },
    ],
    [
      "an upload still processing",
      ok({ status: "PROCESSING_UPLOAD" }),
      direct,
      { providerOperationId: "publish:v1", state: "processing" },
    ],
    [
      "a download still processing",
      ok({ status: "PROCESSING_DOWNLOAD" }),
      inbox,
      { providerOperationId: "inbox:v1", state: "processing" },
    ],
    [
      "an inbox delivery",
      ok({ status: "SEND_TO_USER_INBOX" }),
      inbox,
      {
        state: "delivered",
        result: {
          outcome: "confirmed_success",
          delivery: "inbox",
          providerOperationId: "inbox:v1",
        },
      },
    ],
    [
      "a direct post sent to the inbox",
      ok({ status: "SEND_TO_USER_INBOX" }),
      direct,
      failed(refused("tiktok_sent_to_inbox")),
    ],
    [
      "a retryable failure",
      ok({ status: "FAILED", fail_reason: "internal" }),
      direct,
      failed(providerFailure("transient", "tiktok_internal")),
    ],
    [
      "a removed authorization",
      ok({ status: "FAILED", fail_reason: "AUTH_REMOVED" }),
      direct,
      failed(providerFailure("auth", "tiktok_auth_removed")),
    ],
    [
      "another failure",
      ok({ status: "FAILED", fail_reason: "spam_risk" }),
      direct,
      failed(refused("tiktok_spam_risk")),
    ],
    [
      "an unexplained failure",
      ok({ status: "FAILED" }),
      direct,
      failed(refused("tiktok_publish_failed")),
    ],
    [
      "a completed post with a numeric ID",
      ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [123] }),
      direct,
      {
        result: {
          outcome: "confirmed_success",
          providerOperationId: "publish:v1",
          providerPostId: "123",
        },
        state: "published",
      },
    ],
    [
      "a completed post without an ID",
      ok({ status: "PUBLISH_COMPLETE" }),
      direct,
      {
        result: { outcome: "confirmed_success", providerOperationId: "publish:v1" },
        state: "published",
      },
    ],
  ])("%s", (_example, body, operation, status) => {
    expect(tiktokPublicationStatus(body, operation)).toEqual(status);
  });

  it.each([
    ["an unknown status", ok({ status: "PAUSED" })],
    [
      "post IDs that are not a list",
      ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: "1" }),
    ],
    ["an unusable post ID", ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [""] })],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => tiktokPublicationStatus(body, direct))).toEqual(malformedAnswer);
  });
});
