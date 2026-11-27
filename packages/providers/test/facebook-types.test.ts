import { describe, expect, it } from "vite-plus/test";

import {
  facebookAccountId,
  facebookNativeDraft,
  facebookOperationId,
  facebookPermalink,
  facebookPublishedVideo,
  graphUrl,
  isFacebookReelStatusFailed,
  isFacebookReelStatusPublished,
  nodeUrl,
  parseFacebookOperationId,
  parseFacebookReelStatus,
  validateFacebookUploadUrl,
  type FacebookOperationPhase,
  type FacebookReelStatus,
} from "../src/facebook/types";
import { failureThrownBy, malformedAnswer, refused } from "./support";

describe("graphUrl", () => {
  it("builds a versioned Graph URL", () => {
    expect(graphUrl("me/accounts").toString()).toEqual(
      "https://graph.facebook.com/v25.0/me/accounts",
    );
  });
});

describe("nodeUrl", () => {
  it("a node without fields", () => {
    expect(nodeUrl("page/1").toString()).toEqual("https://graph.facebook.com/v25.0/page%2F1");
  });

  it("a node with fields", () => {
    expect(nodeUrl("page-1", "id,name").toString()).toEqual(
      "https://graph.facebook.com/v25.0/page-1?fields=id%2Cname",
    );
  });
});

describe("facebookPermalink", () => {
  it("encodes the post ID", () => {
    expect(facebookPermalink("page-1_post/2")).toEqual("https://www.facebook.com/page-1_post%2F2");
  });
});

describe("facebookAccountId", () => {
  it("a bound Page ID", () => {
    expect(facebookAccountId({ accessToken: "t", accountId: "page-1" })).toEqual("page-1");
  });

  it("refuses no Page ID", () => {
    expect(failureThrownBy(() => facebookAccountId({ accessToken: "t" }))).toEqual(
      refused("facebook_page_account_required"),
    );
  });
});

describe("facebookOperationId and parseFacebookOperationId", () => {
  it.each<FacebookOperationPhase>([
    "ab_test",
    "ended_live",
    "live",
    "finish_submitted",
    "finishing",
    "post",
    "post_draft",
    "reel_draft",
    "story",
    "upload_submitted",
    "uploaded",
    "video",
    "video_draft",
  ])("round trips phase %s", (phase) => {
    const encoded = facebookOperationId(phase, "id-1");
    expect(encoded).toEqual(`${phase}:id-1`);
    expect(parseFacebookOperationId(encoded)).toEqual({ id: "id-1", phase });
  });

  it.each([
    ["no value", undefined],
    ["an unknown phase", "other:id-1"],
    ["a missing ID", "post:"],
    ["a bad character in ID", "post:bad id"],
  ])("returns undefined for %s", (_example, value) => {
    expect(parseFacebookOperationId(value)).toEqual(undefined);
  });
});

describe("facebookPublishedVideo", () => {
  it("builds a confirmed published post result", () => {
    expect(facebookPublishedVideo("post", "page-1_post-1")).toEqual({
      outcome: "confirmed_success",
      providerOperationId: "post:page-1_post-1",
      providerPostId: "page-1_post-1",
      providerUrl: "https://www.facebook.com/page-1_post-1",
    });
  });

  it("builds a confirmed published video result", () => {
    expect(facebookPublishedVideo("ended_live", "live-1")).toEqual({
      outcome: "confirmed_success",
      providerOperationId: "ended_live:live-1",
      providerPostId: "live-1",
      providerUrl: "https://www.facebook.com/live-1",
    });
  });
});

describe("facebookNativeDraft", () => {
  it.each(["post_draft", "video_draft", "reel_draft"] as const)(
    "builds a draft delivery for %s",
    (phase) => {
      expect(facebookNativeDraft(phase, "item-1")).toEqual({
        delivery: "draft",
        outcome: "confirmed_success",
        providerOperationId: `${phase}:item-1`,
      });
    },
  );
});

describe("validateFacebookUploadUrl", () => {
  it("an https rupload URL for the same video", () => {
    expect(
      validateFacebookUploadUrl(
        "https://rupload.facebook.com/video-upload/v25.0/video-1",
        "video-1",
      ),
    ).toEqual("https://rupload.facebook.com/video-upload/v25.0/video-1");
  });

  it.each([
    ["http", "http://rupload.facebook.com/video-upload/v25.0/video-1"],
    ["another origin", "https://graph.facebook.com/video-upload/v25.0/video-1"],
    ["a query string", "https://rupload.facebook.com/video-upload/v25.0/video-1?a=1"],
    ["another path", "https://rupload.facebook.com/other/v25.0/video-1"],
    ["another video ID", "https://rupload.facebook.com/video-upload/v25.0/video-2"],
    ["a non-string", null],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => validateFacebookUploadUrl(value, "video-1"))).toEqual(
      malformedAnswer,
    );
  });
});

describe("parseFacebookReelStatus", () => {
  const valid = {
    id: "video-1",
    status: {
      processing_phase: { status: "In_Progress" },
      publishing_phase: { status: "NOT_STARTED" },
      uploading_phase: { status: "Complete" },
      video_status: "Processing",
    },
  };

  it("normalizes all four status strings to lowercase", () => {
    expect(parseFacebookReelStatus(valid, "video-1")).toEqual({
      processing: "in_progress",
      publishing: "not_started",
      uploading: "complete",
      video: "processing",
    });
  });

  it.each([
    ["another video ID", { ...valid, id: "video-2" }],
    ["missing status object", { id: "video-1" }],
    [
      "missing publishing phase",
      { id: "video-1", status: { ...valid.status, publishing_phase: {} } },
    ],
    ["a non-object body", null],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => parseFacebookReelStatus(value, "video-1"))).toEqual(
      malformedAnswer,
    );
  });
});

describe("isFacebookReelStatusFailed", () => {
  const healthy: FacebookReelStatus = {
    processing: "complete",
    publishing: "not_started",
    uploading: "complete",
    video: "ready",
  };

  it("a healthy status is not failed", () => {
    expect(isFacebookReelStatusFailed(healthy)).toEqual(false);
  });

  it.each<[string, Partial<FacebookReelStatus>]>([
    ["video expired", { video: "expired" }],
    ["video upload_failed", { video: "upload_failed" }],
    ["video error", { video: "error" }],
    ["uploading failed", { uploading: "failed" }],
    ["processing error", { processing: "error" }],
    ["publishing failed", { publishing: "failed" }],
  ])("flags %s", (_example, patch) => {
    expect(isFacebookReelStatusFailed({ ...healthy, ...patch })).toEqual(true);
  });
});

describe("isFacebookReelStatusPublished", () => {
  const base: FacebookReelStatus = {
    processing: "complete",
    publishing: "not_started",
    uploading: "complete",
    video: "ready",
  };

  it.each([
    ["complete", "complete", true],
    ["completed", "completed", true],
    ["in_progress", "in_progress", false],
  ])("publishing phase %s", (_example, publishing, expected) => {
    expect(isFacebookReelStatusPublished({ ...base, publishing })).toEqual(expected);
  });
});
