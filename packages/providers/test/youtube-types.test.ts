import { describe, expect, it } from "vite-plus/test";

import {
  broadcastOperationId,
  googleErrorDiagnosis,
  parseBroadcastOperationId,
  parseYouTubeOperationId,
  validateSessionUri,
  youtubeAccountId,
  youtubeOperationId,
  youtubeVideoId,
  youtubeWatchUrl,
} from "../src/youtube/types";
import { failureThrownBy, malformedAnswer, refused, unconfirmed } from "./support";

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc";

describe("youtubeAccountId", () => {
  it("a bound channel", () => {
    expect(youtubeAccountId({ accessToken: "a", accountId: "UC1" })).toEqual("UC1");
  });

  it("no channel", () => {
    expect(failureThrownBy(() => youtubeAccountId({ accessToken: "a" }))).toEqual(
      refused("youtube_channel_required"),
    );
  });
});

describe("youtubeWatchUrl", () => {
  it("an ID that needs encoding", () => {
    expect(youtubeWatchUrl("a b")).toEqual("https://youtu.be/a%20b");
  });
});

describe("googleErrorDiagnosis", () => {
  const body = (...reasons: unknown[]) => ({
    error: { errors: reasons.map((reason) => ({ reason })) },
  });
  const quota = { code: "youtube_quota_exceeded", quotaExceeded: true };
  const rate = { code: "youtube_rate_limited", rateLimited: true };

  it.each([
    ["an exhausted quota", body("quotaExceeded"), quota],
    ["a daily limit", body("dailyLimitExceeded"), quota],
    ["a rate limit", body("rateLimitExceeded"), rate],
    ["a user rate limit", body("userRateLimitExceeded"), rate],
    ["a quota beside a rate limit", body("rateLimitExceeded", "quotaExceeded"), quota],
    ["another reason", body("forbidden"), undefined],
    ["a reason that is not text", body(7), undefined],
    ["no error list", { error: {} }, undefined],
    ["no body", undefined, undefined],
  ])("%s", (_example, value, diagnosis) => {
    expect(googleErrorDiagnosis(403, value)).toEqual(diagnosis);
  });
});

describe("validateSessionUri", () => {
  it("a resumable session", () => {
    expect(validateSessionUri(SESSION)).toEqual(SESSION);
  });

  it.each([
    ["no URI", null],
    ["an http URI", SESSION.replace("https", "http")],
    ["another origin", SESSION.replace("www.googleapis.com", "evil.example")],
    ["another path", SESSION.replace("/videos", "/thumbnails")],
    ["no upload ID", "https://www.googleapis.com/upload/youtube/v3/videos"],
    ["two upload IDs", `${SESSION}&upload_id=def`],
    ["an empty upload ID", "https://www.googleapis.com/upload/youtube/v3/videos?upload_id="],
    ["a URI over the operation limit", `${SESSION}${"a".repeat(500)}`],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => validateSessionUri(value))).toEqual(malformedAnswer);
  });
});

describe("youtubeOperationId and parseYouTubeOperationId", () => {
  it.each([
    ["a video", "video:v1", { id: "v1", phase: "video" }],
    [
      "an open session",
      `session:100:${SESSION}`,
      { fileSize: 100, sessionUri: SESSION, phase: "session" },
    ],
    [
      "a submitted session",
      `submitted:100:100:${SESSION}`,
      { acknowledged: 100, fileSize: 100, sessionUri: SESSION, phase: "submitted" },
    ],
    [
      "a session at the size limit",
      `session:524288000:${SESSION}`,
      { fileSize: 524_288_000, sessionUri: SESSION, phase: "session" },
    ],
  ] as const)("%s", (_example, value, operation) => {
    expect(parseYouTubeOperationId(value)).toEqual(operation);
    expect(youtubeOperationId(operation)).toEqual(value);
  });

  it.each([
    ["no value", undefined],
    ["a value with a space", "video:v 1"],
    ["a video without an ID", "video:"],
    ["another phase", `queued:100:${SESSION}`],
    ["a session with acknowledged bytes", `session:100:1:${SESSION}`],
    ["a submission without them", `submitted:100:${SESSION}`],
    ["an empty file", `session:0:${SESSION}`],
    ["a file over the limit", `session:524288001:${SESSION}`],
    ["more bytes acknowledged than sent", `submitted:100:101:${SESSION}`],
    ["a foreign session URI", "session:100:https://evil.example/upload"],
    ["a value over 512 characters", `video:${"a".repeat(507)}`],
  ])("refuses %s", (_example, value) => {
    expect(parseYouTubeOperationId(value)).toEqual(undefined);
  });
});

describe("youtubeVideoId", () => {
  it("a video body", () => {
    expect(youtubeVideoId({ id: "v1" })).toEqual("v1");
  });

  it.each([
    ["a read", false, malformedAnswer],
    ["a possible write", true, unconfirmed],
  ])("no ID on %s", (_example, sideEffectPossible, failure) => {
    expect(failureThrownBy(() => youtubeVideoId({}, sideEffectPossible))).toEqual(failure);
  });
});

describe("broadcastOperationId and parseBroadcastOperationId", () => {
  it.each(["live", "ended_live"] as const)("a %s broadcast", (phase) => {
    const operation = { id: "b1", phase };

    expect(parseBroadcastOperationId(broadcastOperationId(operation))).toEqual(operation);
  });

  it.each([
    ["no value", undefined],
    ["an upload operation", "video:v1"],
    ["no ID", "live:"],
  ])("refuses %s", (_example, value) => {
    expect(parseBroadcastOperationId(value)).toEqual(undefined);
  });
});
