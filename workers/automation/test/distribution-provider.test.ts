import {
  classifyProviderFailure,
  createProviderServiceTest,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { runProviderProgram } from "./provider-program";

import {
  executeProviderCancelEffect,
  executeProviderLookupEffect,
  executeProviderPublishEffect,
  executeProviderReplyEffect,
  type DistributionPublishTarget,
  type PublicationMediaCandidate,
  type PublicationMediaEntry,
  type ProviderReplyTarget,
} from "../src/distribution-provider";

const retryPolicy = {
  baseDelaySeconds: 15,
  maxAttempts: 5,
  maxDelaySeconds: 300,
};

/**
 * Builds one frozen attachment entry with a single ready candidate, matching
 * the ordered `PublicationMediaEntry` shape the distribution pipeline freezes
 * into a publication snapshot at claim.
 */
function mediaEntry(
  patch: Partial<PublicationMediaEntry> = {},
  candidate: Partial<PublicationMediaCandidate> = {},
): PublicationMediaEntry {
  return {
    assetId: "asset-1",
    assetType: "image",
    candidates: [
      {
        contentType: "image/jpeg",
        fileSize: 100,
        height: 1080,
        objectId: "object-1",
        objectKey: "org/asset/image.jpg",
        width: 1080,
        ...candidate,
      },
    ],
    position: 0,
    ...patch,
  };
}

function target(patch: Partial<DistributionPublishTarget> = {}): DistributionPublishTarget {
  return {
    connectionStatus: "connected",
    hashtags: ["launch"],
    idempotencyKey: "operation-1",
    media: [mediaEntry()],
    platform: "threads",
    postId: "post-1",
    providerAccountId: "account-1",
    storedAccessToken: "encrypted-token",
    textContent: "Asset description",
    title: "Asset title",
    tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
    ...patch,
  };
}

/**
 * Builds a publish-capable adapter fixture for the given platform.
 * `publish` and `transferModes` are required because every publication test
 * exercises them; the platform defaults to threads so existing fixtures stay
 * unchanged while TikTok targets can declare a matching capability platform.
 */
function adapter(
  publish: NonNullable<ProviderAdapter["publish"]>,
  transferModes: ProviderAdapter["transferModes"] = ["remote_ingest"],
  platform: ProviderAdapter["capability"]["platform"] = "threads",
): ProviderAdapter {
  return {
    capability: {
      accepted_mime_types: ["image/jpeg"],
      analytics: false,
      asset_types: ["image"],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: 1_000,
      max_hashtags: 5,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: null,
      multi_asset_types: [],
      notes: [],
      platform,
      publish: true,
      reply: false,
    },
    lookupPublication: async () => ({ state: "not_found" }),
    publish,
    retryPolicy,
    transferModes,
  };
}

/**
 * Registers the supplied adapter under its declared capability platform so the
 * registry key and capability platform always satisfy the registry invariant.
 */
function registry(value?: ProviderAdapter): ProviderRegistry {
  const result = new ProviderRegistry();
  if (value) result.register(value.capability.platform, value);
  return result;
}

function replyAdapter(reply: NonNullable<ProviderAdapter["reply"]>): ProviderAdapter {
  const value = adapter(async () => ({
    outcome: "confirmed_success",
    providerPostId: "post-1",
  }));
  value.capability.reply = true;
  value.reply = reply;
  return value;
}

const context = { operationId: "operation-1", requestId: "request-1" };

describe("provider publication execution", () => {
  it("fails closed before credentials when no adapter is accepted", async () => {
    const decryptToken = vi.fn(async () => "provider-token");
    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(),
      context,
      target(),
      {
        decryptToken,
      },
    );

    expect(result.result).toMatchObject({
      failure: {
        classification: "deterministic",
        code: "provider_unavailable",
        retryable: false,
      },
      outcome: "confirmed_failure",
    });
    expect(decryptToken).not.toHaveBeenCalled();
  });

  it("revalidates capability constraints before provider side effects", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    }));
    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(adapter(publish)),
      context,
      target({ media: [mediaEntry({}, { fileSize: 2_000 })] }),
      { decryptToken: async () => "provider-token" },
    );

    expect(result.result).toMatchObject({
      failure: { code: "provider_file_size_limit" },
      outcome: "confirmed_failure",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("prefers remote ingest and keeps credentials outside the publish payload", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: " post-1 ",
      providerUrl: "https://provider.example/posts/1?access_token=must-not-persist#private",
    }));
    const mediaFor = vi.fn(async () => ({
      contentType: "image/jpeg",
      fileSize: 100,
      mode: "remote_ingest" as const,
      url: "https://r2.example/signed-object",
    }));
    // TikTok publish options are only valid on a TikTok target, so the fixture
    // publishes to TikTok; the registry also requires a TikTok adapter to
    // expose creator publication requirements before it accepts registration.
    const tiktok = adapter(publish, ["byte_upload", "resumable_upload", "remote_ingest"], "tiktok");
    tiktok.getPublicationRequirements = async () => ({
      commentAllowed: true,
      creatorDisplayName: "Creator",
      creatorUsername: "creator",
      duetAllowed: false,
      maxVideoDurationSeconds: 600,
      platform: "tiktok",
      privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      stitchAllowed: false,
    });
    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(tiktok),
      context,
      target({
        platform: "tiktok",
        providerOptions: {
          tiktok: {
            allowComment: true,
            allowDuet: false,
            allowStitch: false,
            brandContent: false,
            brandOrganic: false,
            isAiGenerated: false,
            musicUsageConfirmed: true,
            privacyLevel: "PUBLIC_TO_EVERYONE",
          },
        },
      }),
      { decryptToken: async () => "provider-token", mediaFor },
    );

    expect(mediaFor).toHaveBeenCalledWith(
      expect.objectContaining({ transferMode: "remote_ingest" }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      { accessToken: "provider-token", accountId: "account-1" },
      expect.objectContaining({
        caption: "Asset title\n\nAsset description\n\n#launch",
        media: [
          expect.objectContaining({
            metadata: { height: 1080, width: 1080 },
            mode: "remote_ingest",
          }),
        ],
        providerOptions: {
          tiktok: expect.objectContaining({
            musicUsageConfirmed: true,
            privacyLevel: "PUBLIC_TO_EVERYONE",
          }),
        },
      }),
    );
    const publishArguments = publish.mock.calls[0] as unknown as Parameters<
      NonNullable<ProviderAdapter["publish"]>
    >;
    expect(JSON.stringify(publishArguments[2])).not.toContain("provider-token");
    expect(result.result).toEqual({
      outcome: "confirmed_success",
      providerPostId: "post-1",
      providerUrl: "https://provider.example/posts/1",
    });
  });

  it("rejects credentialed remote-ingest URLs before provider access", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    }));
    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(adapter(publish)),
      context,
      target(),
      {
        decryptToken: async () => "provider-token",
        mediaFor: async () => ({
          contentType: "image/jpeg",
          fileSize: 100,
          mode: "remote_ingest",
          url: "https://user:password@r2.example/signed-object",
        }),
      },
    );

    expect(result.result).toMatchObject({
      failure: { code: "provider_preparation_failed" },
      outcome: "confirmed_failure",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("normalizes retryable adapter failures without response leakage", async () => {
    const publish = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({
          code: "rate_limited",
          retryAfterSeconds: 30,
          status: 429,
        }),
      );
    });
    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(adapter(publish)),
      context,
      target(),
      {
        decryptToken: async () => "provider-token",
        mediaFor: async () => ({
          contentType: "image/jpeg",
          fileSize: 100,
          mode: "remote_ingest",
          url: "https://r2.example/signed-object",
        }),
      },
    );

    expect(result).toMatchObject({
      result: {
        failure: {
          classification: "rate_limit",
          code: "rate_limited",
          retryable: true,
          retryAfterSeconds: 30,
        },
        outcome: "confirmed_failure",
      },
      retryPolicy,
    });
  });

  it("turns exceptions and evidence-free success into ambiguous outcomes", async () => {
    const dependencies = {
      decryptToken: async () => "provider-token",
      mediaFor: async () => ({
        contentType: "image/jpeg",
        fileSize: 100,
        mode: "remote_ingest" as const,
        url: "https://r2.example/signed-object",
      }),
    };
    const thrown = await runProviderProgram(
      executeProviderPublishEffect,
      registry(
        adapter(async () => {
          throw new Error("Bearer secret https://provider.example/private");
        }),
      ),
      context,
      target(),
      dependencies,
    );
    const evidenceFree = await runProviderProgram(
      executeProviderPublishEffect,
      registry(adapter(async () => ({ outcome: "confirmed_success" }))),
      context,
      target(),
      dependencies,
    );

    for (const result of [thrown, evidenceFree]) {
      expect(result.result).toMatchObject({
        failure: { classification: "ambiguous", retryable: false },
        outcome: "unknown",
      });
      expect(JSON.stringify(result)).not.toMatch(/Bearer|private|secret/);
    }
  });
});

describe("provider cancellation execution", () => {
  it("uses the accepted cancel adapter with separate credentials", async () => {
    const cancelPublication = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: " cancel-operation-1 ",
    }));
    const registered = adapter(async () => ({
      outcome: "confirmed_success",
      providerPostId: "post-1",
    }));
    registered.cancelPublication = cancelPublication;

    const result = await runProviderProgram(
      executeProviderCancelEffect,
      registry(registered),
      context,
      {
        connectionStatus: "connected",
        platform: "threads",
        providerOperationId: "publish-operation-1",
        providerPostId: "post-1",
        storedAccessToken: "encrypted-token",
        tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
      },
      { decryptToken: async () => "provider-token" },
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(cancelPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      { accessToken: "provider-token" },
      {
        providerOperationId: "publish-operation-1",
        providerPostId: "post-1",
      },
    );
    expect(result.result).toEqual({
      outcome: "confirmed_success",
      providerOperationId: "cancel-operation-1",
    });
  });

  it("fails closed without cancellation capability and makes exceptions ambiguous", async () => {
    const unsupported = await runProviderProgram(
      executeProviderCancelEffect,
      registry(adapter(async () => ({ outcome: "confirmed_success" }))),
      context,
      {
        connectionStatus: "connected",
        platform: "threads",
        providerOperationId: "publish-operation-1",
        providerPostId: null,
        storedAccessToken: "encrypted-token",
        tokenExpiresAt: null,
      },
      { decryptToken: async () => "provider-token" },
    );
    const throwingAdapter = adapter(async () => ({
      outcome: "confirmed_success",
    }));
    throwingAdapter.cancelPublication = async () => {
      throw new Error("Bearer private-cancel-token");
    };
    const thrown = await runProviderProgram(
      executeProviderCancelEffect,
      registry(throwingAdapter),
      context,
      {
        connectionStatus: "connected",
        platform: "threads",
        providerOperationId: "publish-operation-1",
        providerPostId: null,
        storedAccessToken: "encrypted-token",
        tokenExpiresAt: null,
      },
      { decryptToken: async () => "provider-token" },
    );

    expect(unsupported.result).toMatchObject({
      failure: { code: "provider_cancel_unavailable", retryable: false },
      outcome: "confirmed_failure",
    });
    expect(thrown.result).toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
      outcome: "unknown",
    });
    expect(JSON.stringify(thrown)).not.toMatch(/Bearer|private|token/);
  });
});

describe("provider publication lookup", () => {
  const lookupTarget = {
    connectionStatus: "connected",
    platform: "threads" as const,
    providerOperationId: "publish-operation-1",
    providerPostId: null,
    storedAccessToken: "encrypted-token",
    tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
  };

  // Lookup must use the supplied service, not silently replace it with the
  // registry adapter; contradictory provider evidence makes substitution visible.
  it("returns publication evidence from the injected provider service", async () => {
    const registered = adapter(async () => ({ outcome: "confirmed_success" }));
    const result = await Effect.runPromise(
      Effect.provide(
        executeProviderLookupEffect(registry(registered), context, lookupTarget, {
          decryptToken: async () => "provider-token",
        }),
        createProviderServiceTest({
          threads: {
            ...registered,
            lookupPublication: async () => ({
              state: "processing",
              providerOperationId: "injected-operation",
            }),
          },
        }),
      ),
    );
    expect(result.result).toEqual({
      kind: "publication",
      status: {
        state: "processing",
        providerOperationId: "injected-operation",
      },
    });
  });

  it("normalizes processing and published lookup evidence", async () => {
    const lookupPublication = vi
      .fn()
      .mockResolvedValueOnce({
        providerOperationId: " publish-operation-1 ",
        state: "processing" as const,
      })
      .mockResolvedValueOnce({
        result: {
          outcome: "confirmed_success" as const,
          providerOperationId: "publish-operation-1",
          providerPostId: "post-1",
          providerUrl: "https://provider.example/posts/1?token=private#secret",
        },
        state: "published" as const,
      });
    const registered = adapter(async () => ({
      outcome: "confirmed_success",
      providerPostId: "post-1",
    }));
    registered.lookupPublication = lookupPublication;
    const accepted = registry(registered);
    const dependencies = { decryptToken: async () => "provider-token" };

    const processing = await runProviderProgram(
      executeProviderLookupEffect,
      accepted,
      context,
      lookupTarget,
      dependencies,
    );
    const published = await runProviderProgram(
      executeProviderLookupEffect,
      accepted,
      context,
      lookupTarget,
      dependencies,
    );

    expect(lookupPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      { accessToken: "provider-token" },
      { providerOperationId: "publish-operation-1" },
    );
    expect(processing.result).toEqual({
      kind: "publication",
      status: {
        providerOperationId: "publish-operation-1",
        state: "processing",
      },
    });
    expect(published.result).toEqual({
      kind: "publication",
      status: {
        result: {
          outcome: "confirmed_success",
          providerOperationId: "publish-operation-1",
          providerPostId: "post-1",
          providerUrl: "https://provider.example/posts/1",
        },
        state: "published",
      },
    });
  });

  it("keeps lookup exceptions retryable without leaking response details", async () => {
    const registered = adapter(async () => ({
      outcome: "confirmed_success",
      providerPostId: "post-1",
    }));
    registered.lookupPublication = async () => {
      throw new Error("Bearer private-token https://provider.example/internal");
    };

    const result = await runProviderProgram(
      executeProviderLookupEffect,
      registry(registered),
      context,
      lookupTarget,
      { decryptToken: async () => "provider-token" },
    );

    expect(result.result).toMatchObject({
      failure: {
        classification: "transient",
        code: "provider_lookup_failed",
        retryable: true,
      },
      kind: "lookup_failure",
    });
    expect(JSON.stringify(result)).not.toMatch(/Bearer|internal|private/);
  });
});

describe("provider reply execution", () => {
  const replyTarget: ProviderReplyTarget = {
    connectionStatus: "connected",
    idempotencyKey: "reply-operation-1",
    platform: "threads",
    providerAccountId: "account-1",
    providerCommentId: "comment-1",
    storedAccessToken: "encrypted-token",
    text: "Thanks for the feedback",
    tokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
  };

  it("passes isolated credentials and durable reply identifiers", async () => {
    const reply = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "reply-container-1",
      providerPostId: "reply-post-1",
    }));
    const result = await runProviderProgram(
      executeProviderReplyEffect,
      registry(replyAdapter(reply)),
      context,
      replyTarget,
      { decryptToken: async () => "provider-token" },
      new Date("2026-01-01T00:00:00Z"),
    );

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      { accessToken: "provider-token", accountId: "account-1" },
      {
        idempotencyKey: "reply-operation-1",
        providerCommentId: "comment-1",
        text: "Thanks for the feedback",
      },
    );
    expect(result).toEqual({
      result: {
        outcome: "confirmed_success",
        providerOperationId: "reply-container-1",
        providerPostId: "reply-post-1",
      },
      retryPolicy,
    });
  });

  it("fails closed before credential use when reply is unavailable", async () => {
    const decryptToken = vi.fn(async () => "provider-token");
    const result = await runProviderProgram(
      executeProviderReplyEffect,
      registry(),
      context,
      replyTarget,
      { decryptToken },
    );

    expect(result.result).toMatchObject({
      failure: { code: "provider_reply_unavailable", retryable: false },
      outcome: "confirmed_failure",
    });
    expect(decryptToken).not.toHaveBeenCalled();
  });

  it("classifies an exception after the write starts as ambiguous", async () => {
    const result = await runProviderProgram(
      executeProviderReplyEffect,
      registry(
        replyAdapter(async () => {
          throw new Error("Bearer private-reply-token");
        }),
      ),
      context,
      replyTarget,
      { decryptToken: async () => "provider-token" },
    );

    expect(result.result).toMatchObject({
      failure: { classification: "ambiguous", retryable: false },
      outcome: "unknown",
    });
    expect(JSON.stringify(result)).not.toMatch(/Bearer|private|token/);
  });
});

describe("expired token refresh before publish", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  /**
   * Publish target whose stored token expired before `now`, with a refresh
   * credential present so the just-in-time refresh path is exercised.
   */
  const expiredTarget = (
    patch: Partial<DistributionPublishTarget> = {},
  ): DistributionPublishTarget =>
    target({
      platformAccountId: "platform-account-1",
      storedRefreshToken: "enc-refresh",
      tokenExpiresAt: new Date("2026-05-01T00:00:00Z"),
      ...patch,
    });
  /** Remote-ingest media descriptor the publish flow resolves before upload. */
  const mediaFor = async () => ({
    contentType: "image/jpeg",
    fileSize: 100,
    mode: "remote_ingest" as const,
    url: "https://r2.example/signed-object",
  });

  it("persists the rotated credentials before publishing with the fresh token", async () => {
    const calls: string[] = [];
    const publish = vi.fn(async () => {
      calls.push("publish");
      return {
        outcome: "confirmed_success" as const,
        providerPostId: "post-1",
      };
    });
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-new",
      expiresAt: "2026-07-01T00:00:00Z",
      refreshToken: "refresh-new",
      scopes: ["threads_basic"],
    }));
    const registered = adapter(publish);
    registered.refreshAccessToken = refreshAccessToken;
    const decryptToken = vi.fn(async (stored: string) => `decrypted:${stored}`);
    const persistRefreshedTokens = vi.fn(async () => {
      calls.push("persist");
      return true;
    });

    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(registered),
      context,
      expiredTarget(),
      { decryptToken, mediaFor, persistRefreshedTokens },
      now,
    );

    expect(refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: context.operationId,
        requestId: context.requestId,
      }),
      "decrypted:enc-refresh",
    );
    expect(persistRefreshedTokens).toHaveBeenCalledWith({
      accessToken: "access-new",
      expiresAt: "2026-07-01T00:00:00.000Z",
      platformAccountId: "platform-account-1",
      refreshToken: "refresh-new",
      scopes: ["threads_basic"],
    });
    expect(calls).toEqual(["persist", "publish"]);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      { accessToken: "access-new", accountId: "account-1" },
      expect.anything(),
    );
    expect(result.result).toEqual({
      outcome: "confirmed_success",
      providerPostId: "post-1",
    });
  });

  it("persists rotated credentials without expiresAt when provider refresh returns no expiry", async () => {
    const calls: string[] = [];
    const publish = vi.fn(async () => {
      calls.push("publish");
      return {
        outcome: "confirmed_success" as const,
        providerPostId: "post-1",
      };
    });
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      scopes: ["threads_basic"],
    }));
    const registered = adapter(publish);
    registered.refreshAccessToken = refreshAccessToken;
    const decryptToken = vi.fn(async (stored: string) => `decrypted:${stored}`);
    const persistRefreshedTokens = vi.fn(async () => {
      calls.push("persist");
      return true;
    });

    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(registered),
      context,
      expiredTarget(),
      { decryptToken, mediaFor, persistRefreshedTokens },
      now,
    );

    expect(persistRefreshedTokens).toHaveBeenCalledWith({
      accessToken: "access-new",
      platformAccountId: "platform-account-1",
      refreshToken: "refresh-new",
      scopes: ["threads_basic"],
    });
    expect(calls).toEqual(["persist", "publish"]);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      { accessToken: "access-new", accountId: "account-1" },
      expect.anything(),
    );
    expect(result.result).toEqual({
      outcome: "confirmed_success",
      providerPostId: "post-1",
    });
  });

  it("falls back to the access token as the refresh credential when no refresh token is stored", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    }));
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-new",
      expiresAt: "2026-07-01T00:00:00Z",
      refreshToken: "access-new",
      scopes: ["threads_basic"],
    }));
    const registered = adapter(publish);
    registered.refreshAccessToken = refreshAccessToken;

    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(registered),
      context,
      expiredTarget({ storedRefreshToken: null }),
      {
        decryptToken: async (stored) => `decrypted:${stored}`,
        mediaFor,
        persistRefreshedTokens: async () => true,
      },
      now,
    );

    expect(refreshAccessToken).toHaveBeenCalledWith(expect.anything(), "decrypted:encrypted-token");
    expect(result.result).toMatchObject({ outcome: "confirmed_success" });
  });

  it("fails to reconnect without publish when refresh is unavailable or rejected", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    }));
    // No refreshAccessToken on the adapter: the expired token cannot be
    // refreshed safely, so the publish must not run.
    const unsupported = await runProviderProgram(
      executeProviderPublishEffect,
      registry(adapter(publish)),
      context,
      expiredTarget(),
      {
        decryptToken: async () => "provider-token",
        mediaFor,
        persistRefreshedTokens: async () => true,
      },
      now,
    );
    // Refresh-capable adapter rejecting the grant: still no publish.
    const rejecting = adapter(publish);
    rejecting.refreshAccessToken = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "invalid_grant", status: 401 }),
      );
    });
    const rejected = await runProviderProgram(
      executeProviderPublishEffect,
      registry(rejecting),
      context,
      expiredTarget(),
      {
        decryptToken: async () => "provider-token",
        mediaFor,
        persistRefreshedTokens: async () => true,
      },
      now,
    );
    // Refresh-capable adapter but no atomic persistence dependency: the
    // rotation could not be committed, so the publish must not run either.
    const refreshing = adapter(publish);
    refreshing.refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-new",
      expiresAt: "2026-07-01T00:00:00Z",
      scopes: ["threads_basic"],
    }));
    const unpersistable = await runProviderProgram(
      executeProviderPublishEffect,
      registry(refreshing),
      context,
      expiredTarget(),
      { decryptToken: async () => "provider-token", mediaFor },
      now,
    );

    for (const result of [unsupported, rejected, unpersistable]) {
      expect(result.result).toMatchObject({
        failure: { code: "provider_reconnect_required" },
        outcome: "confirmed_failure",
      });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(refreshing.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("fails to reconnect without publish when the rotation cannot be persisted", async () => {
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "post-1",
    }));
    const registered = adapter(publish);
    registered.refreshAccessToken = vi.fn(async () => ({
      accessToken: "access-new",
      expiresAt: "2026-07-01T00:00:00Z",
      refreshToken: "refresh-new",
      scopes: ["threads_basic"],
    }));

    const result = await runProviderProgram(
      executeProviderPublishEffect,
      registry(registered),
      context,
      expiredTarget(),
      {
        decryptToken: async () => "provider-token",
        mediaFor,
        persistRefreshedTokens: async () => false,
      },
      now,
    );

    expect(result.result).toMatchObject({
      failure: { code: "provider_reconnect_required" },
      outcome: "confirmed_failure",
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
