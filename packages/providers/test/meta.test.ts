import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ProviderHttpClient } from "../src/http";
import {
  containerOperationId,
  createMetaContainer,
  insightValue,
  lookupMetaContainer,
  lookupMetaPost,
  parseContainerOperationId,
  parseMetaCommentPage,
  parseMetaInsightsMap,
  parseMetaReply,
  readMetaContainer,
  requestMetaBearerToken,
  type MetaContainerProtocol,
} from "../src/meta";

const context = { operationId: "op-1", requestId: "req-1" };
const MALFORMED = "The provider is temporarily unavailable.";
const NOW = new Date("2026-01-02T00:00:00.000Z");
const credentials = { accessToken: "token" };
const limits = { tokenLifetimeMaxSeconds: 100, tokenMaxChars: 10 };

const protocol: MetaContainerProtocol = {
  containerReadUrl: (id) => `https://graph.test/${id}`,
  extractWarnings: (body) => (body.warn ? ["instagram_publish_partial"] : undefined),
  failureDetailField: "error_message",
  provider: "instagram",
  publishUrl: (_credentials, id) => `https://graph.test/publish?id=${id}`,
  publishedOperationPhase: "retain",
  statusField: "status",
};

type Answer = Response | Error;

function setup(...answers: Answer[]) {
  const requests: string[] = [];
  const http = new ProviderHttpClient({
    allowedOrigins: ["https://graph.test"],
    platform: "instagram",
    fetch: (input, init) => {
      requests.push(`${init?.method} ${String(input)}`);
      const answer = answers.shift() ?? new Error("unexpected request");
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  return { http, requests };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const comment = { id: "c1", text: "hi", timestamp: "2026-01-02T00:00:00Z", username: "ann" };
const parsedComment = {
  authorDisplayName: "ann",
  body: "hi",
  commentedAt: "2026-01-02T00:00:00.000Z",
  providerCommentId: "c1",
  providerPostId: "p1",
};
const mapping = { usernameField: "username" };

beforeAll(async () => {
  const { http } = setup(json({ id: "9" }));
  await readMetaContainer(http, protocol, context, "token", "9");
});

describe("containerOperationId", () => {
  it("a phase and an ID", () => {
    expect(containerOperationId("created", "123")).toEqual("created:123");
  });
});

describe("parseContainerOperationId", () => {
  it.each([
    ["a created container", "created:123", { id: "123", phase: "created" }],
    ["a submitted container", "submitted:123", { id: "123", phase: "submitted" }],
    ["another phase", "queued:123", undefined],
    ["no ID", "created:", undefined],
    ["a value that is not text", 5, undefined],
  ])("%s", (_example, value, operation) => {
    expect(parseContainerOperationId(value)).toEqual(operation);
  });
});

describe("insightValue", () => {
  it.each([
    ["a periodic bucket", { values: [{ value: 4 }, { value: 9 }] }, 4],
    ["a lifetime total", { total_value: { value: 7 } }, 7],
    ["an empty bucket list", { values: [] }, undefined],
    ["no value", {}, undefined],
  ])("%s", (_example, metric, value) => {
    expect(insightValue(metric)).toEqual(value);
  });
});

describe("parseMetaInsightsMap", () => {
  it("two metrics", () => {
    const body = {
      data: [
        { name: "views", values: [{ value: 1 }] },
        { name: "likes", total_value: { value: 0 } },
      ],
    };

    expect(parseMetaInsightsMap(body)).toEqual(
      new Map([
        ["views", 1],
        ["likes", 0],
      ]),
    );
  });

  it.each([
    ["data that is not a list", { data: {} }, false],
    [
      "21 metrics",
      {
        data: Array.from({ length: 21 }, (_, i) => ({ name: `m${i}`, total_value: { value: 1 } })),
      },
      false,
    ],
    ["an entry that is not an object", { data: ["x"] }, false],
    ["a metric without a name", { data: [{ total_value: { value: 1 } }] }, false],
    ["a metric without a value", { data: [{ name: "views" }] }, false],
    [
      "a repeated metric",
      {
        data: [
          { name: "a", total_value: { value: 1 } },
          { name: "a", total_value: { value: 1 } },
        ],
      },
      false,
    ],
    [
      "two buckets where one is required",
      { data: [{ name: "a", values: [{ value: 1 }, { value: 2 }] }] },
      true,
    ],
  ])("refuses %s", (_example, body, singleValue) => {
    expect(() => parseMetaInsightsMap(body, { singleValue })).toThrow(MALFORMED);
  });
});

describe("parseMetaCommentPage", () => {
  it("an empty page", () => {
    expect(parseMetaCommentPage({ data: [] }, "p1", 10, mapping)).toEqual({ items: [] });
  });

  it("a comment with a nested author, an avatar and a cursor", () => {
    const body = {
      data: [
        { ...comment, username: undefined, from: { name: "Ann" }, avatar: "https://a.test/x" },
      ],
      paging: { cursors: { after: "next" } },
    };
    const nested = { avatarField: "avatar", nestedAuthorField: "from", usernameField: "name" };

    expect(parseMetaCommentPage(body, "p1", 1, nested)).toEqual({
      items: [{ ...parsedComment, authorAvatarUrl: "https://a.test/x", authorDisplayName: "Ann" }],
      nextCursor: "next",
    });
  });

  it("an anonymous comment with empty text", () => {
    const body = { data: [{ ...comment, text: "", username: undefined }], paging: {} };

    expect(parseMetaCommentPage(body, "p1", 10, mapping)).toEqual({
      items: [{ ...parsedComment, authorDisplayName: undefined, body: "" }],
    });
  });

  it.each([
    ["no data list", {}],
    ["more comments than the limit", { data: [comment, { ...comment, id: "c2" }] }],
    ["a comment without an ID", { data: [{ ...comment, id: undefined }] }],
    ["text of 10001 characters", { data: [{ ...comment, text: "a".repeat(10_001) }] }],
    ["an unusable time", { data: [{ ...comment, timestamp: "x" }] }],
    ["a blank username", { data: [{ ...comment, username: " " }] }],
    ["paging that is not an object", { data: [], paging: "x" }],
    ["cursors that are not an object", { data: [], paging: { cursors: "x" } }],
    ["an unusable cursor", { data: [], paging: { cursors: { after: "" } } }],
  ])("refuses %s", (_example, body) => {
    expect(() => parseMetaCommentPage(body, "p1", 1, mapping)).toThrow(MALFORMED);
  });

  it("refuses a repeated comment ID", () => {
    expect(() => parseMetaCommentPage({ data: [comment, comment] }, "p1", 10, mapping)).toThrow(
      MALFORMED,
    );
  });

  it("refuses an http avatar", () => {
    const body = { data: [{ ...comment, avatar: "http://a.test" }] };

    expect(() =>
      parseMetaCommentPage(body, "p1", 10, { ...mapping, avatarField: "avatar" }),
    ).toThrow(MALFORMED);
  });
});

describe("parseMetaReply", () => {
  const reply = {
    idempotencyKey: "k",
    providerCommentId: "c1",
    providerPostId: "p1",
    text: " ok ",
  };

  it.each([
    ["a padded reply", {}, { providerCommentId: "c1", text: "ok" }],
    ["a bad comment ID", { providerCommentId: "a b" }, undefined],
    ["a blank reply", { text: "  " }, undefined],
    ["a reply over the maximum", { text: "abcdef" }, undefined],
  ])("%s", (_example, patch, parsed) => {
    expect(parseMetaReply({ ...reply, ...patch }, 5)).toEqual(parsed);
  });
});

describe("requestMetaBearerToken", () => {
  it("a bearer token", async () => {
    const { http, requests } = setup(
      json({ access_token: "long", token_type: "bearer", expires_in: 60 }),
    );

    const token = await requestMetaBearerToken(
      http,
      context,
      "https://graph.test/token",
      { grant_type: "refresh" },
      limits,
      NOW,
    );

    expect(token).toEqual({ accessToken: "long", expiresAt: "2026-01-02T00:01:00.000Z" });
    expect(requests).toEqual(["GET https://graph.test/token?grant_type=refresh"]);
  });

  it.each([
    ["another token type", { access_token: "long", token_type: "mac", expires_in: 60 }],
    [
      "a token over the maximum",
      { access_token: "a".repeat(11), token_type: "bearer", expires_in: 60 },
    ],
    [
      "a lifetime over the maximum",
      { access_token: "long", token_type: "bearer", expires_in: 101 },
    ],
  ])("refuses %s", async (_example, body) => {
    const { http } = setup(json(body));

    await expect(
      requestMetaBearerToken(http, context, "https://graph.test/token", {}, limits, NOW),
    ).rejects.toThrow(MALFORMED);
  });
});

describe("lookupMetaPost", () => {
  const lookup = (permalink: "required" | "optional", answer: Answer) => {
    const { http, requests } = setup(answer);
    const result = lookupMetaPost(
      http,
      context,
      credentials,
      { providerPostId: "p1", providerOperationId: "created:1" },
      new URL("https://graph.test/p1"),
      permalink,
    );
    return { result, requests };
  };
  const published = {
    outcome: "confirmed_success",
    providerOperationId: "created:1",
    providerPostId: "p1",
  };

  it("a post with a permalink", async () => {
    const { result, requests } = lookup(
      "required",
      json({ id: "p1", permalink: "https://a.test/p" }),
    );

    expect(await result).toEqual({
      result: { ...published, providerUrl: "https://a.test/p" },
      state: "published",
    });
    expect(requests).toEqual(["GET https://graph.test/p1?fields=id%2Cpermalink"]);
  });

  it("a post with an optional permalink missing", async () => {
    const { result } = lookup("optional", json({ id: "p1" }));

    expect(await result).toEqual({ result: published, state: "published" });
  });

  it("a deleted post", async () => {
    const { result } = lookup("required", json({}, 404));

    expect(await result).toEqual({ state: "not_found" });
  });

  it("a provider error", async () => {
    const { result } = lookup("required", json({}, 500));

    await expect(result).rejects.toThrow(MALFORMED);
  });

  it.each([
    ["another post's ID", "optional", { id: "p2" }],
    ["a required permalink missing", "required", { id: "p1" }],
    ["an unusable optional permalink", "optional", { id: "p1", permalink: "http://a.test" }],
  ] as const)("refuses %s", async (_example, permalink, body) => {
    const { result } = lookup(permalink, json(body));

    await expect(result).rejects.toThrow(MALFORMED);
  });
});

describe("createMetaContainer", () => {
  it("a created container", async () => {
    const { http, requests } = setup(json({ id: "9" }));

    const id = await createMetaContainer(
      http,
      context,
      "token",
      new URL("https://graph.test/media"),
      new URLSearchParams({ caption: "hi" }),
    );

    expect(id).toEqual("9");
    expect(requests).toEqual(["POST https://graph.test/media?caption=hi"]);
  });

  it("an answer without an ID", async () => {
    const { http } = setup(json({}));

    await expect(
      createMetaContainer(
        http,
        context,
        "token",
        new URL("https://graph.test/media"),
        new URLSearchParams(),
      ),
    ).rejects.toThrow(MALFORMED);
  });
});

describe("readMetaContainer", () => {
  const read = (answer: Answer) => {
    const { http } = setup(answer);
    return readMetaContainer(http, protocol, context, "token", "9");
  };

  it("an existing container", async () => {
    expect(await read(json({ id: "9", status: "FINISHED" }))).toEqual({
      id: "9",
      status: "FINISHED",
    });
  });

  it("a missing container", async () => {
    expect(await read(json({}, 404))).toEqual(undefined);
  });

  it("another container's ID", async () => {
    await expect(read(json({ id: "8" }))).rejects.toThrow(MALFORMED);
  });

  it("a provider error", async () => {
    await expect(read(json({}, 500))).rejects.toThrow(MALFORMED);
  });
});

describe("lookupMetaContainer", () => {
  const run = (phase: "created" | "submitted", ...answers: Answer[]) => {
    const { http, requests } = setup(...answers);
    return {
      status: lookupMetaContainer(http, protocol, context, credentials, { id: "9", phase }),
      requests,
    };
  };
  const container = (status: string, extra: object = {}) => json({ id: "9", status, ...extra });
  const failed = (code: string, operation = "created:9") => ({
    result: expect.objectContaining({
      failure: expect.objectContaining({ code }),
      outcome: "confirmed_failure",
      providerOperationId: operation,
    }),
    state: "failed",
  });

  it("a container still processing", async () => {
    const { status } = run("created", container("IN_PROGRESS"));

    expect(await status).toEqual({ providerOperationId: "created:9", state: "processing" });
  });

  it("a missing container", async () => {
    const { status } = run("created", json({}, 404));

    expect(await status).toEqual({ state: "not_found" });
  });

  it("a finished container is published once", async () => {
    const { status, requests } = run(
      "created",
      container("FINISHED"),
      json({ id: "p1", warn: true }),
    );

    expect(await status).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "created:9",
        providerPostId: "p1",
        warnings: ["instagram_publish_partial"],
      },
      state: "published",
    });
    expect(requests).toEqual(["GET https://graph.test/9", "POST https://graph.test/publish?id=9"]);
  });

  it("a finished container already submitted", async () => {
    const { status, requests } = run("submitted", container("FINISHED"));

    expect(await status).toEqual({
      result: expect.objectContaining({
        failure: expect.objectContaining({ code: "instagram_publish_evidence_missing" }),
        outcome: "unknown",
        providerOperationId: "submitted:9",
      }),
      state: "unknown",
    });
    expect(requests).toEqual(["GET https://graph.test/9"]);
  });

  it("a publish with an unknown outcome", async () => {
    const { status } = run("created", container("FINISHED"), new TypeError("socket"));

    expect(await status).toEqual({
      result: expect.objectContaining({ outcome: "unknown", providerOperationId: "submitted:9" }),
      state: "unknown",
    });
  });

  it("a publish answered without a post ID", async () => {
    const { status } = run("created", container("FINISHED"), json({}));

    expect(await status).toEqual({
      result: expect.objectContaining({ outcome: "unknown", providerOperationId: "submitted:9" }),
      state: "unknown",
    });
  });

  it("a rate-limited publish", async () => {
    const { status } = run("created", container("FINISHED"), json({}, 429));

    expect(await status).toEqual({ providerOperationId: "created:9", state: "processing" });
  });

  it("a refused publish", async () => {
    const { status } = run("created", container("FINISHED"), json({}, 400));

    expect(await status).toEqual(failed("provider_http_400"));
  });

  it("a published container", async () => {
    const { status } = run("created", container("PUBLISHED"));

    expect(await status).toEqual({
      result: { outcome: "confirmed_success", providerOperationId: "created:9" },
      state: "published",
    });
  });

  it("an expired container", async () => {
    const { status } = run("created", container("EXPIRED"));

    expect(await status).toEqual(failed("instagram_container_expired"));
  });

  it.each([
    ["a download failure", "Could not fetch the file", "instagram_container_media_retrieval"],
    ["a duration failure", "Video is too long", "instagram_container_media_duration"],
    ["a dimension failure", "Bad aspect ratio", "instagram_container_media_dimensions"],
    ["a format failure", "Unsupported codec", "instagram_container_media_format"],
    ["an unexplained failure", "Something broke", "instagram_container_error"],
    ["a failure without detail", undefined, "instagram_container_error"],
  ])("%s", async (_example, detail, code) => {
    const { status } = run("created", container("ERROR", { error_message: detail }));

    expect(await status).toEqual(failed(code));
  });

  it("an unknown status", async () => {
    const { status } = run("created", container("PAUSED"));

    await expect(status).rejects.toThrow(MALFORMED);
  });
});
