// @vitest-environment jsdom

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  Asset,
  CompleteUploadInput,
  CreateUploadPartsInput,
  CreateUploadPartsResponse,
  CreateUploadSessionInput,
  UploadSessionResponse,
} from "@/types";
import type { ApiRequestOptions } from "./api";
import { listResumableUploads, uploadAssetFile, type UploadApi } from "./upload";

const completedAsset = { id: "asset-1" } as Asset;
const BRAND_PROFILE_ID = "00000000-0000-4000-8000-000000000111";
const OTHER_PROFILE_ID = "00000000-0000-4000-8000-000000000222";
const CREATE_KEY = /^upload-create-/;

class FakeXMLHttpRequest {
  static statusByUrl = new Map<string, number>();
  static holdUrls = new Set<string>();
  static onSendByUrl = new Map<string, (complete: () => void) => void>();
  static abortResolvers = new Map<string, () => void>();
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
    const hook = FakeXMLHttpRequest.onSendByUrl.get(this.#url);
    if (hook) {
      hook(complete);
      return;
    }
    if (FakeXMLHttpRequest.holdUrls.has(this.#url)) return;
    complete();
  }

  setRequestHeader() {}

  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    FakeXMLHttpRequest.abortedUrls.push(this.#url);
    const finish = () => {
      this.readyState = FakeXMLHttpRequest.DONE;
      this.onabort?.();
    };
    if (FakeXMLHttpRequest.holdUrls.has(this.#url)) {
      FakeXMLHttpRequest.abortResolvers.set(this.#url, finish);
      return;
    }
    finish();
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

class FakeUploadApi implements UploadApi {
  readonly aborts: {
    options?: ApiRequestOptions;
    sessionId: string;
    workspaceId: string | null;
  }[] = [];
  readonly completions: {
    input?: CompleteUploadInput;
    options?: ApiRequestOptions;
    sessionId: string;
    workspaceId: string | null;
  }[] = [];
  readonly creations: {
    input: CreateUploadSessionInput;
    options?: ApiRequestOptions;
    workspaceId: string | null;
  }[] = [];
  readonly partRequests: {
    input: CreateUploadPartsInput;
    options?: ApiRequestOptions;
    sessionId: string;
    workspaceId: string | null;
  }[] = [];
  nextCreateFailures: unknown[] = [];
  partResponse: CreateUploadPartsResponse = { parts: [] };

  constructor(private readonly session: UploadSessionResponse) {}

  abortUploadSession(
    workspaceId: string | null,
    sessionId: string,
    options?: ApiRequestOptions,
  ): Effect.Effect<void, unknown> {
    this.aborts.push({ options, sessionId, workspaceId });
    return Effect.succeed(undefined);
  }

  completeUploadSession(
    workspaceId: string | null,
    sessionId: string,
    input?: CompleteUploadInput,
    options?: ApiRequestOptions,
  ): Effect.Effect<Asset, unknown> {
    this.completions.push({ input, options, sessionId, workspaceId });
    return Effect.succeed(completedAsset);
  }

  createUploadPartUrls(
    workspaceId: string | null,
    sessionId: string,
    input: CreateUploadPartsInput,
    options?: ApiRequestOptions,
  ): Effect.Effect<CreateUploadPartsResponse, unknown> {
    this.partRequests.push({ input, options, sessionId, workspaceId });
    return Effect.succeed(this.partResponse);
  }

  createUploadSession(
    workspaceId: string | null,
    input: CreateUploadSessionInput,
    options?: ApiRequestOptions,
  ): Effect.Effect<UploadSessionResponse, unknown> {
    this.creations.push({ input, options, workspaceId });
    if (this.nextCreateFailures.length > 0) {
      return Effect.fail(this.nextCreateFailures.shift());
    }
    return Effect.succeed(this.session);
  }

  getUploadSession(): Effect.Effect<UploadSessionResponse & { uploaded_parts: [] }, unknown> {
    return Effect.succeed({ ...this.session, uploaded_parts: [] });
  }
}

function singleSession(
  id: string,
  url: string,
  contentType = "image/png",
  fileSize = 3,
): UploadSessionResponse {
  return {
    asset: completedAsset,
    upload_session: {
      asset_id: "asset-1",
      content_type: contentType,
      expires_at: "2099-07-18T16:00:00Z",
      file_size: fileSize,
      id,
      multipart: null,
      single_upload: {
        expires_at: "2099-07-18T16:00:00Z",
        headers: { "Content-Type": contentType },
        method: "PUT",
        url,
      },
      status: "created",
      strategy: "single",
    },
  };
}

function multipartSession(id: string, fileSize: number, partSize: number): UploadSessionResponse {
  return {
    asset: completedAsset,
    upload_session: {
      asset_id: "asset-1",
      content_type: "video/mp4",
      expires_at: "2099-07-18T16:00:00Z",
      file_size: fileSize,
      id,
      multipart: {
        max_parallel_parts: 2,
        part_count: Math.ceil(fileSize / partSize),
        part_size: partSize,
      },
      single_upload: null,
      status: "created",
      strategy: "multipart",
    },
  };
}

function signedParts(partNumbers: readonly number[]): CreateUploadPartsResponse {
  return {
    parts: partNumbers.map((partNumber) => ({
      expires_at: "2099-07-18T16:00:00Z",
      headers: {},
      method: "PUT" as const,
      part_number: partNumber,
      url: `https://upload.example.test/${partNumber}`,
    })),
  };
}

beforeAll(() => {
  writeCookieConsent({ functional: true });
  listResumableUploads(new MemoryStorage());
});

beforeEach(() => {
  window.localStorage.clear();
  writeCookieConsent({ functional: true });
  FakeXMLHttpRequest.statusByUrl.clear();
  FakeXMLHttpRequest.holdUrls.clear();
  FakeXMLHttpRequest.onSendByUrl.clear();
  FakeXMLHttpRequest.abortResolvers.clear();
  FakeXMLHttpRequest.abortedUrls.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  window.localStorage.clear();
});

describe("uploadAssetFile", () => {
  it("uploads and completes a single-part session", async () => {
    const api = new FakeUploadApi(singleSession("session-1", "https://upload.example.test/single"));
    const progress: number[] = [];

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file: new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }),
      onProgress: (percent) => progress.push(percent),
      retryBaseDelayMs: 0,
      workspaceId: "workspace-1",
    });

    expect(result).toEqual(completedAsset);
    expect(api.creations).toEqual([
      {
        input: {
          asset_type: "image",
          brand_profile_id: BRAND_PROFILE_ID,
          content_type: "image/png",
          file_size: 3,
          filename: "cover.png",
          title: "cover",
        },
        options: { idempotencyKey: expect.stringMatching(CREATE_KEY) },
        workspaceId: "workspace-1",
      },
    ]);
    expect(api.completions).toEqual([
      {
        input: {},
        options: { idempotencyKey: "upload-complete-session-1" },
        sessionId: "session-1",
        workspaceId: "workspace-1",
      },
    ]);
    expect(api.aborts).toEqual([]);
    expect(progress.at(-1)).toEqual(100);
  });

  it("uploads without touching recovery storage when functional consent is declined", async () => {
    writeCookieConsent({ functional: false });
    const storage = new MemoryStorage();
    const api = new FakeUploadApi(
      singleSession("session-no-consent", "https://upload.example.test/no-consent"),
    );

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file: new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }),
      retryBaseDelayMs: 0,
      storage,
      workspaceId: "workspace-1",
    });

    expect(result).toEqual(completedAsset);
    expect(storage.length).toEqual(0);
    expect(listResumableUploads(storage)).toEqual([]);
  });

  it.each([
    [
      "a throwing onSessionStart subscriber",
      () => {
        throw new Error("subscriber bug");
      },
    ],
    [
      "a rejecting onSessionStart subscriber",
      async () => {
        throw new Error("subscriber bug");
      },
    ],
  ])("completes despite %s", async (_example, subscriber) => {
    const api = new FakeUploadApi(singleSession("session-1", "https://upload.example.test/single"));
    const started: string[] = [];

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file: new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }),
      onSessionStart: ((assetId: string) => {
        started.push(assetId);
        return subscriber();
      }) as (assetId: string) => void,
      retryBaseDelayMs: 0,
      workspaceId: "workspace-1",
    });

    expect(result).toEqual(completedAsset);
    expect(started).toEqual(["asset-1"]);
    expect(api.aborts).toEqual([]);
  });

  it("reuses the create idempotency key after a response-loss failure", async () => {
    const storage = new MemoryStorage();
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    const api = new FakeUploadApi(
      singleSession("session-response-loss", "https://upload.example.test/retry-create"),
    );
    api.nextCreateFailures = [new Error("response lost after acceptance")];

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file,
        retryBaseDelayMs: 0,
        storage,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("response lost after acceptance");
    const firstKey = api.creations[0]?.options?.idempotencyKey;

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file,
      retryBaseDelayMs: 0,
      storage,
      workspaceId: "workspace-1",
    });

    expect(result).toEqual(completedAsset);
    expect(api.creations[1]?.options?.idempotencyKey).toEqual(firstKey);
    expect(storage.length).toEqual(0);
  });

  it("uses a fresh create key for the same file under another Brand Profile", async () => {
    const storage = new MemoryStorage();
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    const api = new FakeUploadApi(
      singleSession("session-other-profile", "https://upload.example.test/other-profile"),
    );
    api.nextCreateFailures = [new Error("response lost after acceptance")];

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file,
        retryBaseDelayMs: 0,
        storage,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("response lost after acceptance");
    await uploadAssetFile({
      api,
      brandProfileId: OTHER_PROFILE_ID,
      file,
      retryBaseDelayMs: 0,
      storage,
      workspaceId: "workspace-1",
    });

    expect(api.creations[1]?.options?.idempotencyKey).not.toEqual(
      api.creations[0]?.options?.idempotencyKey,
    );
  });

  it("signs, uploads, sorts, and completes a multipart session", async () => {
    const file = new File([new Uint8Array(9)], "movie.mp4", { type: "video/mp4" });
    const api = new FakeUploadApi(multipartSession("session-multipart", 9, 4));
    api.partResponse = signedParts([3, 1, 2]);

    const result = await uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file,
      retryBaseDelayMs: 0,
      workspaceId: "workspace-1",
    });

    expect(result).toEqual(completedAsset);
    expect(api.partRequests).toEqual([
      {
        input: { part_numbers: [1, 2, 3] },
        options: { idempotencyKey: "upload-parts-session-multipart-1-3" },
        sessionId: "session-multipart",
        workspaceId: "workspace-1",
      },
    ]);
    expect(api.completions).toEqual([
      {
        input: {
          parts: [
            { etag: "etag-1", part_number: 1 },
            { etag: "etag-2", part_number: 2 },
            { etag: "etag-3", part_number: 3 },
          ],
        },
        options: { idempotencyKey: "upload-complete-session-multipart" },
        sessionId: "session-multipart",
        workspaceId: "workspace-1",
      },
    ]);
  });

  it("aborts and awaits sibling parts after a fatal multipart failure", async () => {
    const file = new File([new Uint8Array(12)], "movie.mp4", { type: "video/mp4" });
    const storage = new MemoryStorage();
    const api = new FakeUploadApi(multipartSession("session-sibling-failure", 12, 4));
    api.partResponse = signedParts([1, 2, 3]);
    FakeXMLHttpRequest.statusByUrl.set("https://upload.example.test/1", 500);
    FakeXMLHttpRequest.holdUrls.add("https://upload.example.test/3");
    let finishPartOne: (() => void) | undefined;
    let partThreeStarted = false;
    FakeXMLHttpRequest.onSendByUrl.set("https://upload.example.test/1", (complete) => {
      if (partThreeStarted) complete();
      else finishPartOne = complete;
    });
    FakeXMLHttpRequest.onSendByUrl.set("https://upload.example.test/3", () => {
      partThreeStarted = true;
      finishPartOne?.();
    });

    let settled = false;
    const upload = uploadAssetFile({
      api,
      brandProfileId: BRAND_PROFILE_ID,
      file,
      retryBaseDelayMs: 0,
      storage,
      workspaceId: "workspace-1",
    });
    void upload.catch(() => {
      settled = true;
    });

    await vi.waitFor(
      () => {
        expect(FakeXMLHttpRequest.abortResolvers.has("https://upload.example.test/3")).toEqual(
          true,
        );
      },
      { interval: 1 },
    );
    expect(FakeXMLHttpRequest.abortedUrls).toEqual(["https://upload.example.test/3"]);
    expect(settled).toEqual(false);

    FakeXMLHttpRequest.abortResolvers.get("https://upload.example.test/3")?.();
    await expect(upload).rejects.toThrow("status 500");
    expect(api.completions).toEqual([]);
    expect(listResumableUploads(storage)).toEqual([
      {
        assetId: "asset-1",
        completedParts: [{ etag: "etag-2", part_number: 2 }],
        expiresAt: "2099-07-18T16:00:00Z",
        file: { lastModified: file.lastModified, name: "movie.mp4", size: 12, type: "video/mp4" },
        sessionId: "session-sibling-failure",
        strategy: "multipart",
        version: 1,
      },
    ]);
  });

  it("keeps a resumable session when a direct upload fails", async () => {
    FakeXMLHttpRequest.statusByUrl.set("https://upload.example.test/fail", 500);
    const api = new FakeUploadApi(
      singleSession("session-fail", "https://upload.example.test/fail", "video/mp4", 1),
    );

    await expect(
      uploadAssetFile({
        api,
        brandProfileId: BRAND_PROFILE_ID,
        file: new File([new Uint8Array([1])], "movie.mp4", { type: "video/mp4" }),
        retryBaseDelayMs: 0,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("status 500");
    expect(api.aborts).toEqual([]);
    expect(api.completions).toEqual([]);
  });
});

describe("listResumableUploads", () => {
  it("drops expired records from storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "meltiply.upload.v1.expired",
      JSON.stringify({
        assetId: "asset-old",
        completedParts: [],
        expiresAt: "2000-01-01T00:00:00Z",
        file: { lastModified: 1, name: "old.mp4", size: 10, type: "video/mp4" },
        sessionId: "expired",
        strategy: "single",
        version: 1,
      }),
    );

    expect(listResumableUploads(storage)).toEqual([]);
    expect(storage.length).toEqual(0);
  });
});
