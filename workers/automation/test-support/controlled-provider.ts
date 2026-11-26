import { PLATFORM_IDS } from "@meltiply/domain";
import {
  createFacebookAdapter,
  createInstagramAdapter,
  createThreadsAdapter,
  createTikTokAdapter,
  createYouTubeAdapter,
  normalizeProviderFailure,
  ProviderRegistry,
  type OAuthConnection,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderFailure,
  type ProviderOperationResult,
  type ProviderPublicationLookup,
  type ProviderPublicationStatus,
  type ProviderPublicationRequirements,
  type ProviderPublishOptions,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderTransferMode,
  type PublishInput,
} from "@meltiply/providers";
import type { Platform, PlatformCapability } from "@meltiply/domain";

export interface ControlledProviderBucket {
  delete(keys: string | string[]): Promise<void>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    json<T>(): Promise<T>;
  } | null>;
  list(options?: { cursor?: string; limit?: number; prefix?: string }): Promise<{
    objects: { key: string }[];
    truncated?: boolean;
  }>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const controlledProviderPrefix = "controlled-provider";

export const controlledProviderPlatforms = PLATFORM_IDS;

type ControlledProviderPlatform = (typeof controlledProviderPlatforms)[number];

interface ControlledPublicationMedia {
  checksum: string;
  contentType: string;
  fileSize: number;
  key: string;
}

interface ControlledPublicationState {
  state: "published" | "cancelled";
}

export interface ControlledPublication extends ControlledPublicationState {
  accountId: string;
  caption: string;
  hashtags: string[];
  media: ControlledPublicationMedia[];
  operationId: string;
  platform: ControlledProviderPlatform;
  publicationId: string;
  publishedAt: string;
  providerOptions?: ProviderPublishOptions;
}

export interface ControlledProviderScript {
  failNextPublishes: number;
}

export interface ControlledProviderOptions {
  bucket: ControlledProviderBucket;
  now?: () => Date;
}

const retryPolicy: ProviderRetryPolicy = {
  baseDelaySeconds: 1,
  maxAttempts: 3,
  maxDelaySeconds: 5,
};

const transferModes: readonly ProviderTransferMode[] = ["byte_upload"];

const fixtureClientId = "controlled-provider-client";
const fixtureClientSecret = "controlled-provider-secret";
const fixtureRedirectUri = "https://controlled-provider.invalid/oauth/callback";
const fixtureAuthorizationOrigin = "https://controlled-provider.invalid";

function controlledPublicationKey(accountId: string, publicationId: string): string {
  return `${controlledProviderPrefix}/publications/${encodeURIComponent(accountId)}/${encodeURIComponent(publicationId)}.json`;
}

function controlledMediaKey(publicationId: string, index: number): string {
  return `${controlledProviderPrefix}/media/${encodeURIComponent(publicationId)}/${index}`;
}

function controlledScriptKey(accountId: string): string {
  return `${controlledProviderPrefix}/scripts/${encodeURIComponent(accountId)}.json`;
}

async function listAllKeys(bucket: ControlledProviderBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      limit: 1_000,
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.objects[page.objects.length - 1]?.key : undefined;
  } while (cursor !== undefined);
  return keys;
}

export async function readControlledPublications(
  bucket: ControlledProviderBucket,
  accountId: string,
): Promise<ControlledPublication[]> {
  const prefix = `${controlledProviderPrefix}/publications/${encodeURIComponent(accountId)}/`;
  const keys = await listAllKeys(bucket, prefix);
  const records = await Promise.all(
    keys.map(async (key) => {
      const object = await bucket.get(key);
      return object ? object.json<ControlledPublication>() : null;
    }),
  );
  return records.filter((record): record is ControlledPublication => record !== null);
}

export async function readControlledScript(
  bucket: ControlledProviderBucket,
  accountId: string,
): Promise<ControlledProviderScript | null> {
  const object = await bucket.get(controlledScriptKey(accountId));
  return object ? object.json<ControlledProviderScript>() : null;
}

export async function writeControlledScript(
  bucket: ControlledProviderBucket,
  accountId: string,
  script: ControlledProviderScript | null,
): Promise<ControlledProviderScript | null> {
  const key = controlledScriptKey(accountId);
  if (script === null) {
    await bucket.delete(key);
    return null;
  }
  await bucket.put(key, JSON.stringify(script), {
    httpMetadata: { contentType: "application/json" },
  });
  return script;
}

function controlledCapability(platform: Platform): PlatformCapability {
  const options = {
    clientId: fixtureClientId,
    clientSecret: fixtureClientSecret,
    redirectUri: fixtureRedirectUri,
  };
  const adapter =
    platform === "facebook"
      ? createFacebookAdapter(options)
      : platform === "instagram"
        ? createInstagramAdapter(options)
        : platform === "threads"
          ? createThreadsAdapter(options)
          : platform === "youtube"
            ? createYouTubeAdapter(options)
            : platform === "tiktok"
              ? createTikTokAdapter({
                  ...options,
                  clientId: fixtureClientId,
                  mediaUrlPrefix: "https://controlled-provider.invalid/media/",
                })
              : undefined;
  if (!adapter) {
    throw new TypeError(`controlled provider does not serve ${platform}`);
  }
  return adapter.capability;
}

async function consumeScriptedFailure(
  bucket: ControlledProviderBucket,
  accountId: string,
): Promise<boolean> {
  const script = await readControlledScript(bucket, accountId);
  if (!script || script.failNextPublishes <= 0) return false;
  await writeControlledScript(bucket, accountId, {
    failNextPublishes: script.failNextPublishes - 1,
  });
  return true;
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(source: BufferSource): ArrayBuffer {
  const viewed = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return viewed.slice().buffer;
}

function scriptedFailure(accountId: string): ProviderFailure {
  return normalizeProviderFailure({
    classification: "transient",
    code: "controlled_provider_scripted_failure",
    message: `Controlled provider rejected one scripted attempt for ${accountId}`,
    retryable: true,
  });
}

function requireAccountId(credentials: ProviderCredentials): string {
  const accountId = credentials.accountId?.trim();
  if (!accountId) {
    throw new TypeError("controlled provider call has no account identity");
  }
  return accountId;
}

function createControlledAdapter(
  platform: ControlledProviderPlatform,
  options: ControlledProviderOptions,
): ProviderAdapter {
  const now = options.now ?? (() => new Date());
  const bucket = options.bucket;

  return {
    capability: controlledCapability(platform),

    ...(platform === "tiktok"
      ? {
          async getPublicationRequirements(
            _context: ProviderRequestContext,
            credentials: ProviderCredentials,
          ): Promise<ProviderPublicationRequirements> {
            return {
              platform: "tiktok",
              creatorDisplayName: "Acceptance TikTok creator",
              creatorUsername: requireAccountId(credentials),
              commentAllowed: true,
              duetAllowed: true,
              stitchAllowed: false,
              maxVideoDurationSeconds: 60,
              privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
            };
          },
        }
      : {}),

    authorizationUrl(input): string {
      const url = new URL("/oauth/authorize", fixtureAuthorizationOrigin);
      url.searchParams.set("client_id", fixtureClientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", input.state);
      return url.toString();
    },

    async exchangeAuthorizationCode(
      _context: ProviderRequestContext,
      input,
    ): Promise<OAuthConnection> {
      const accountId = `controlled-${platform}-${encodeURIComponent(input.code)}`;
      return {
        accessToken: `controlled-provider-token-${input.code}`,
        account: {
          displayName: `Controlled ${platform} Account`,
          id: accountId,
        },
        scopes: ["publish"],
      };
    },

    async lookupPublication(
      _context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderPublicationStatus> {
      const accountId = requireAccountId(credentials);
      const publicationId = lookup.providerPostId?.trim();
      if (!publicationId) return { state: "not_found" };
      const object = await bucket.get(controlledPublicationKey(accountId, publicationId));
      if (!object) return { state: "not_found" };
      const record = await object.json<ControlledPublication>();
      if (record.state !== "published") {
        return {
          state: "failed",
          result: {
            outcome: "confirmed_failure",
            providerOperationId: record.operationId,
            failure: normalizeProviderFailure({
              classification: "deterministic",
              code: "controlled_provider_cancelled",
              message: "The controlled provider copy was cancelled.",
              retryable: false,
            }),
          },
        };
      }
      return {
        state: "published",
        result: {
          outcome: "confirmed_success",
          providerOperationId: record.operationId,
          providerPostId: record.publicationId,
          providerUrl: `https://controlled-provider.invalid/${platform}/${encodeURIComponent(record.publicationId)}`,
        },
      };
    },

    async publish(
      context: ProviderRequestContext,
      credentials: ProviderCredentials,
      input: PublishInput,
    ): Promise<ProviderOperationResult> {
      const accountId = requireAccountId(credentials);
      if (await consumeScriptedFailure(bucket, accountId)) {
        return {
          outcome: "confirmed_failure",
          providerOperationId: context.operationId,
          failure: scriptedFailure(accountId),
        };
      }

      const publicationId = crypto.randomUUID();
      const media: ControlledPublicationMedia[] = [];
      for (const [index, item] of input.media.entries()) {
        if (item.mode !== "byte_upload") {
          return {
            outcome: "confirmed_failure",
            providerOperationId: context.operationId,
            failure: normalizeProviderFailure({
              classification: "deterministic",
              code: "controlled_provider_transfer_mode",
              message: `Controlled provider only accepts byte uploads, received ${item.mode}.`,
              retryable: false,
            }),
          };
        }
        const bytes = await readBody(item.body);
        const checksum = await sha256Hex(bytes);
        const key = controlledMediaKey(publicationId, index);
        await bucket.put(key, toArrayBuffer(bytes), {
          httpMetadata: { contentType: item.contentType },
        });
        media.push({
          checksum,
          contentType: item.contentType,
          fileSize: bytes.byteLength,
          key,
        });
      }

      const record: ControlledPublication = {
        accountId,
        caption: input.caption,
        hashtags: [...input.hashtags],
        media,
        operationId: context.operationId,
        platform,
        publicationId,
        publishedAt: now().toISOString(),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        state: "published",
      };
      await bucket.put(controlledPublicationKey(accountId, publicationId), JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
      });

      return {
        outcome: "confirmed_success",
        providerOperationId: context.operationId,
        providerPostId: publicationId,
        providerUrl: `https://controlled-provider.invalid/${platform}/${encodeURIComponent(publicationId)}`,
      };
    },

    async cancelPublication(
      _context: ProviderRequestContext,
      credentials: ProviderCredentials,
      lookup: ProviderPublicationLookup,
    ): Promise<ProviderOperationResult> {
      const accountId = requireAccountId(credentials);
      const publicationId = lookup.providerPostId?.trim();
      if (!publicationId) {
        return {
          outcome: "confirmed_failure",
          failure: normalizeProviderFailure({
            classification: "deterministic",
            code: "controlled_provider_missing_copy",
            message: "No controlled provider copy matched this cancellation.",
            retryable: false,
          }),
        };
      }
      const key = controlledPublicationKey(accountId, publicationId);
      const object = await bucket.get(key);
      if (!object) {
        return {
          outcome: "confirmed_failure",
          failure: normalizeProviderFailure({
            classification: "deterministic",
            code: "controlled_provider_missing_copy",
            message: "No controlled provider copy matched this cancellation.",
            retryable: false,
          }),
        };
      }
      const record = await object.json<ControlledPublication>();
      await bucket.put(
        key,
        JSON.stringify({
          ...record,
          state: "cancelled",
        } satisfies ControlledPublication),
        { httpMetadata: { contentType: "application/json" } },
      );
      await bucket.delete(record.media.map((item) => item.key));
      return {
        outcome: "confirmed_success",
        providerOperationId: record.operationId,
        providerPostId: record.publicationId,
      };
    },

    async listAnalytics() {
      return { items: [] };
    },

    async listComments() {
      return { items: [] };
    },

    async reply(_context, _credentials, replyInput) {
      return {
        outcome: "confirmed_success" as const,
        providerOperationId: `controlled-reply:${replyInput.providerCommentId}`,
      };
    },

    retryPolicy,
    transferModes,
  };
}

export function createControlledProviderRegistry(
  options: ControlledProviderOptions,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const platform of controlledProviderPlatforms) {
    registry.register(platform, createControlledAdapter(platform, options));
  }
  return registry;
}
