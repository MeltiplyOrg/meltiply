// @vitest-environment jsdom

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { listResumableUploads, uploadAssetFile, type UploadApi } from "./upload";
import type { Asset, UploadSessionResponse } from "@/types";

const completedAsset = { id: "asset-1" } as Asset;

/**
 * Fixed Brand Profile UUID shared by every upload fixture; `uploadAssetFile`
 * requires it because `CreateUploadSessionRequest.brand_profile_id` is
 * mandatory on the contract.
 */
const BRAND_PROFILE_ID = "00000000-0000-4000-8000-000000000111";

class FakeXMLHttpRequest {
  static statusByUrl = new Map<string, number>();
  static delayByUrl = new Map<string, number>();
  static abortDelayByUrl = new Map<string, number>();
  static readonly abortedUrls: string[] = [];
  static readonly DONE = 4;

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  readyState = 1;
  status = 0;
  #url = "";
  #aborted = false;

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "etag" ? `etag-${this.#url.split("/").at(-1)}` : null;
  }

  open(_method: string, url: string) {
    this.#url = url;
  }

  send(body: Blob) {
    const complete = () => {
      if (this.#aborted) return;
      this.status = FakeXMLHttpRequest.statusByUrl.get(this.#url) ?? 200;
      this.readyState = FakeXMLHttpRequest.DONE;
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: body.size,
        total: body.size,
      } as ProgressEvent);
      this.onload?.();
    };
    const delay = FakeXMLHttpRequest.delayByUrl.get(this.#url) ?? 0;
    if (delay > 0) globalThis.setTimeout(complete, delay);
    else complete();
  }

  setRequestHeader() {}

  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    FakeXMLHttpRequest.abortedUrls.push(this.#url);
    const interrupted = () => {
      this.readyState = FakeXMLHttpRequest.DONE;
      this.onabort?.();
    };
    const delay = FakeXMLHttpRequest.abortDelayByUrl.get(this.#url) ?? 0;
    if (delay > 0) globalThis.setTimeout(interrupted, delay);
    else interrupted();
  }
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function sessionResponse(session: UploadSessionResponse["upload_session"]): UploadSessionResponse {
  return {
    asset: completedAsset,
    upload_session: session,
  };
}

function apiFor(session: UploadSessionResponse) {
  return {
    abortUploadSession: vi.fn<UploadApi["abortUploadSession"]>(() => Effect.succeed(undefined)),
    completeUploadSession: vi.fn<UploadApi["completeUploadSession"]>(() =>
      Effect.succeed(completedAsset),
    ),
    createUploadPartUrls: vi.fn<UploadApi["createUploadPartUrls"]>(() =>
      Effect.succeed({ parts: [] }),
    ),
    createUploadSession: vi.fn<UploadApi["createUploadSession"]>(() => Effect.succeed(session)),
    getUploadSession: vi.fn<UploadApi["getUploadSession"]>(() =>
      Effect.succeed({
        ...session,
        uploaded_parts: [],
      }),
    ),
  };
}

describe("contract upload sessions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    FakeXMLHttpRequest.statusByUrl.clear();
    FakeXMLHttpRequest.delayByUrl.clear();
    FakeXMLHttpRequest.abortDelayByUrl.clear();
    FakeXMLHttpRequest.abortedUrls.length = 0;
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
    window.localStorage.clear();
  });

  it("uploads and completes a single-part session", async () => {
    const api = apiFor(
      sessionResponse({
        asset_id: "asset-1",
        content_type: "image/png",
        expires_at: "2099-07-18T16:00:00Z",
        file_size: 3,
        id: "session-1",
        multipart: null,
        single_upload: {
          expires_at: "2099-07-18T16:00:00Z",
          headers: { "Content-Type": "image/png" },
          method: "PUT",
          url: "https://upload.example.test/single",
        },
        status: "created",
        strategy: "single",
      }),
    );
    const progress = vi.fn();

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file: new File([new Uint8Array([1, 2, 3])], "cover.png", {
        type: "image/png",
      }),
      onProgress: progress,
      workspaceId: "workspace-1",
    });

    expect(result).toBe(completedAsset);
    expect(api.createUploadSession).toHaveBeenCalledWith(
      "workspace-1",
      {
        asset_type: "image",
        brand_profile_id: BRAND_PROFILE_ID,
        content_type: "image/png",
        file_size: 3,
        filename: "cover.png",
        title: "cover",
      },
      expect.objectContaining({ idempotencyKey: expect.stringContaining("upload-create-") }),
    );
    expect(api.completeUploadSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      {},
      { idempotencyKey: "upload-complete-session-1" },
    );
    expect(api.abortUploadSession).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(100);
  });
  /**
   * Uploads remain server-backed when functional consent is rejected, while
   * local recovery reads and writes remain entirely disabled.
   */
  it("continues upload without accessing optional recovery storage after rejection", async () => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    const storage = new MemoryStorage();
    const api = apiFor(
      sessionResponse({
        asset_id: "asset-1",
        content_type: "image/png",
        expires_at: "2099-07-18T16:00:00Z",
        file_size: 3,
        id: "session-no-consent",
        multipart: null,
        single_upload: {
          expires_at: "2099-07-18T16:00:00Z",
          headers: { "Content-Type": "image/png" },
          method: "PUT",
          url: "https://upload.example.test/no-consent",
        },
        status: "created",
        strategy: "single",
      }),
    );

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file: new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }),
        storage,
        workspaceId: "workspace-1",
      }),
    ).resolves.toBe(completedAsset);
    expect(api.createUploadSession).toHaveBeenCalledOnce();
    expect(storage.length).toBe(0);
    expect(listResumableUploads(storage)).toEqual([]);
  });

  // Both failure shapes a `(assetId) => void` subscriber can produce must be
  // ignored: a synchronous throw and — legal because async functions satisfy a
  // void-returning signature — a returned promise that rejects. The rejection
  // is swallowed inside `#loadSession` the moment the call returns, so the
  // outcome below is deterministic: the upload completes in both cases.
  it.each([
    {
      label: "synchronously throws",
      subscriber: (): void => {
        throw new Error("subscriber bug");
      },
    },
    {
      label: "rejects asynchronously",
      subscriber: async (): Promise<void> => {
        throw new Error("subscriber bug");
      },
    },
  ])(
    "ignores an onSessionStart subscriber that $label and still completes",
    async ({ subscriber }) => {
      const api = apiFor(
        sessionResponse({
          asset_id: "asset-1",
          content_type: "image/png",
          expires_at: "2099-07-18T16:00:00Z",
          file_size: 3,
          id: "session-1",
          multipart: null,
          single_upload: {
            expires_at: "2099-07-18T16:00:00Z",
            headers: { "Content-Type": "image/png" },
            method: "PUT",
            url: "https://upload.example.test/single",
          },
          status: "created",
          strategy: "single",
        }),
      );
      const onSessionStart = vi.fn<(assetId: string) => void>(subscriber);

      const result = await uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file: new File([new Uint8Array([1, 2, 3])], "cover.png", {
          type: "image/png",
        }),
        onSessionStart,
        workspaceId: "workspace-1",
      });

      expect(onSessionStart).toHaveBeenCalledWith("asset-1");
      expect(result).toBe(completedAsset);
      expect(api.completeUploadSession).toHaveBeenCalled();
      expect(api.abortUploadSession).not.toHaveBeenCalled();
    },
  );

  it("reuses the create idempotency key after a response-loss failure", async () => {
    const storage = new MemoryStorage();
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", {
      type: "image/png",
    });
    const session = sessionResponse({
      asset_id: "asset-1",
      content_type: "image/png",
      expires_at: "2099-07-18T16:00:00Z",
      file_size: file.size,
      id: "session-response-loss",
      multipart: null,
      single_upload: {
        expires_at: "2099-07-18T16:00:00Z",
        headers: { "Content-Type": "image/png" },
        method: "PUT",
        url: "https://upload.example.test/retry-create",
      },
      status: "created",
      strategy: "single",
    });
    const api = apiFor(session);
    api.createUploadSession
      .mockReturnValueOnce(Effect.fail(new Error("response lost after acceptance")))
      .mockReturnValueOnce(Effect.succeed(session));

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file,
        storage,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("response lost after acceptance");
    const firstKey = api.createUploadSession.mock.calls[0]?.[2]?.idempotencyKey;
    expect(firstKey).toEqual(expect.stringContaining("upload-create-"));

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file,
        storage,
        workspaceId: "workspace-1",
      }),
    ).resolves.toBe(completedAsset);
    expect(api.createUploadSession.mock.calls[1]?.[2]?.idempotencyKey).toBe(firstKey);
    expect(storage.length).toBe(0);
  });

  it("signs, uploads, sorts, and completes multipart sessions", async () => {
    const partSize = 5 * 1024 * 1024;
    const file = new File([new Uint8Array(partSize * 2 + 1)], "movie.mp4", {
      type: "video/mp4",
    });
    const api = apiFor(
      sessionResponse({
        asset_id: "asset-1",
        content_type: "video/mp4",
        expires_at: "2099-07-18T16:00:00Z",
        file_size: file.size,
        id: "session-multipart",
        multipart: {
          max_parallel_parts: 2,
          part_count: 3,
          part_size: partSize,
        },
        single_upload: null,
        status: "created",
        strategy: "multipart",
      }),
    );
    api.createUploadPartUrls.mockReturnValue(
      Effect.succeed({
        parts: [3, 1, 2].map((partNumber) => ({
          expires_at: "2099-07-18T16:00:00Z",
          headers: {},
          method: "PUT" as const,
          part_number: partNumber,
          url: `https://upload.example.test/${partNumber}`,
        })),
      }),
    );

    await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file,
      workspaceId: "workspace-1",
    });

    expect(api.createUploadPartUrls).toHaveBeenCalledWith(
      "workspace-1",
      "session-multipart",
      { part_numbers: [1, 2, 3] },
      { idempotencyKey: "upload-parts-session-multipart-1-3" },
    );
    expect(api.completeUploadSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-multipart",
      {
        parts: [
          { etag: "etag-1", part_number: 1 },
          { etag: "etag-2", part_number: 2 },
          { etag: "etag-3", part_number: 3 },
        ],
      },
      { idempotencyKey: "upload-complete-session-multipart" },
    );
  });

  it("aborts and awaits sibling parts after a fatal multipart failure", async () => {
    vi.useFakeTimers();
    const partSize = 5 * 1024 * 1024;
    const file = new File([new Uint8Array(partSize * 3)], "movie.mp4", {
      type: "video/mp4",
    });
    const storage = new MemoryStorage();
    const api = apiFor(
      sessionResponse({
        asset_id: "asset-1",
        content_type: "video/mp4",
        expires_at: "2099-07-18T16:00:00Z",
        file_size: file.size,
        id: "session-sibling-failure",
        multipart: {
          max_parallel_parts: 2,
          part_count: 3,
          part_size: partSize,
        },
        single_upload: null,
        status: "created",
        strategy: "multipart",
      }),
    );
    api.createUploadPartUrls.mockReturnValue(
      Effect.succeed({
        parts: [1, 2, 3].map((partNumber) => ({
          expires_at: "2099-07-18T16:00:00Z",
          headers: {},
          method: "PUT" as const,
          part_number: partNumber,
          url: `https://upload.example.test/${partNumber}`,
        })),
      }),
    );
    FakeXMLHttpRequest.statusByUrl.set("https://upload.example.test/1", 500);
    FakeXMLHttpRequest.delayByUrl.set("https://upload.example.test/3", 60_000);
    FakeXMLHttpRequest.abortDelayByUrl.set("https://upload.example.test/3", 100);

    let settled = false;
    const result = uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file,
      storage,
      workspaceId: "workspace-1",
    });
    void result.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    expect(FakeXMLHttpRequest.abortedUrls).toContain("https://upload.example.test/3");
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).rejects.toThrow("status 500");
    expect(settled).toBe(true);
    expect(api.completeUploadSession).not.toHaveBeenCalled();
    expect(listResumableUploads(storage)).toEqual([
      expect.objectContaining({
        completedParts: [{ etag: "etag-2", part_number: 2 }],
        sessionId: "session-sibling-failure",
      }),
    ]);
  });

  it("keeps a resumable session when a direct upload fails", async () => {
    FakeXMLHttpRequest.statusByUrl.set("https://upload.example.test/fail", 500);
    const api = apiFor(
      sessionResponse({
        asset_id: "asset-1",
        content_type: "video/mp4",
        expires_at: "2026-07-18T16:00:00Z",
        file_size: 1,
        id: "session-fail",
        multipart: null,
        single_upload: {
          expires_at: "2099-07-18T16:00:00Z",
          headers: {},
          method: "PUT",
          url: "https://upload.example.test/fail",
        },
        status: "created",
        strategy: "single",
      }),
    );

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file: new File([new Uint8Array([1])], "movie.mp4", {
          type: "video/mp4",
        }),
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("status 500");
    expect(api.abortUploadSession).not.toHaveBeenCalled();
    expect(api.completeUploadSession).not.toHaveBeenCalled();
  });
});
