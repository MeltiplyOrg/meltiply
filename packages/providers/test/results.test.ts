import { describe, expect, it } from "vite-plus/test";

import { rejected, rejection } from "../src/failures";
import {
  confirmedFailure,
  engagementSnapshot,
  failedWriteResult,
  unknownResult,
} from "../src/results";

const denied = rejection("tiktok_denied", 422);
const unknown = {
  classification: "ambiguous",
  code: "publish_unknown",
  message: "The provider outcome could not be confirmed.",
  retryable: false,
};

describe("confirmedFailure", () => {
  it("a failure with an operation", () => {
    expect(confirmedFailure(denied, "publish:1")).toEqual({
      failure: denied,
      outcome: "confirmed_failure",
      providerOperationId: "publish:1",
    });
  });

  it("a failure without an operation", () => {
    expect(confirmedFailure(denied)).toEqual({ failure: denied, outcome: "confirmed_failure" });
  });
});

describe("unknownResult", () => {
  it("a code with an operation", () => {
    expect(unknownResult("publish_unknown", "publish:1")).toEqual({
      failure: unknown,
      outcome: "unknown",
      providerOperationId: "publish:1",
    });
  });

  it("a code without an operation", () => {
    expect(unknownResult("publish_unknown")).toEqual({ failure: unknown, outcome: "unknown" });
  });
});

describe("failedWriteResult", () => {
  it("an uncertain failure", () => {
    const cause = rejected("publish_unknown", 503);

    expect(failedWriteResult(cause, "uncertain:1", "confirmed:1")).toEqual({
      failure: unknown,
      outcome: "unknown",
      providerOperationId: "uncertain:1",
    });
  });

  it("a certain failure", () => {
    const cause = rejected("tiktok_denied", 422);

    expect(failedWriteResult(cause, "uncertain:1", "confirmed:1")).toEqual({
      failure: denied,
      outcome: "confirmed_failure",
      providerOperationId: "confirmed:1",
    });
  });

  it("a certain failure with one operation ID", () => {
    const cause = rejected("tiktok_denied", 422);

    expect(failedWriteResult(cause, "publish:1")).toEqual({
      failure: denied,
      outcome: "confirmed_failure",
      providerOperationId: "publish:1",
    });
  });

  it("an error that is not from a provider", () => {
    const cause = new TypeError("bug");

    expect(() => failedWriteResult(cause)).toThrow(cause);
  });
});

describe("engagementSnapshot", () => {
  const counts = { comments: 1, likes: 2, providerPostId: "post-1", shares: 3, views: 4 };
  const recordedAt = new Date("2026-01-02T03:04:05.000Z");

  it.each([
    ["counts without reach", counts, 0],
    ["counts with reach", { ...counts, reach: 9 }, 9],
  ])("%s", (_example, input, reach) => {
    expect(engagementSnapshot(input, recordedAt)).toEqual({
      items: [
        {
          ...counts,
          impressions: 0,
          reach,
          recordedAt: "2026-01-02T03:04:05.000Z",
          watchTimeSeconds: 0,
        },
      ],
    });
  });
});
