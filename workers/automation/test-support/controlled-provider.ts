/**
 * Controlled external Provider fixture for local browser acceptance.
 *
 * This module is the "platform side" of issue #284 acceptance: it implements the
 * real {@link ProviderAdapter} contract, so the production API, outbox, queue,
 * claim, publication-snapshot, provider-media, and reconciliation code all run
 * unchanged against it. It deliberately lives in `test-support` and is only ever
 * wired into the fixture Worker entries through the existing
 * `createApiApp({ providerRegistry })` / `createAutomationHandler({ providerRegistry })`
 * dependency seams — there is no production route, interface, or mock switch.
 *
 * Durability contract: every accepted publication is written as one immutable
 * R2 record plus one R2 object per attachment, holding the real bytes the
 * automation Worker streamed out of the ASSETS bucket together with their
 * verified SHA-256 digest, declared content type, and byte length. Acceptance
 * therefore asserts against the provider's own live copies (record count,
 * stored caption, retrieved bytes and checksum) rather than against anything the
 * application itself remembers.
 *
 * Ownership: this file is shared by both fixture entries — `workers/api` reads
 * publications and scripts it wrote, `workers/automation` creates them — because
 * both Workers bind the same local `meltiply-assets-local` bucket. Keeping one
 * implementation is what makes the API-side reads observe the exact bytes the
 * automation-side publish wrote.
 */

import {
  createInstagramAdapter,
  createThreadsAdapter,
  normalizeProviderFailure,
  ProviderRegistry,
  type OAuthConnection,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderFailure,
  type ProviderOperationResult,
  type ProviderPublicationLookup,
  type ProviderPublicationStatus,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderTransferMode,
  type PublishInput,
} from "@meltiply/providers";
import type { Platform, PlatformCapability } from "@meltiply/domain";

/**
 * Minimal structural R2 surface the fixture needs.
 *
 * Declared structurally rather than as `R2Bucket` so the same module compiles
 * inside both Workers without either depending on the other's generated
 * `worker-configuration.d.ts`.
 */
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

/** R2 key prefix that namespaces every object this fixture owns. */
const controlledProviderPrefix = "controlled-provider";

/** Platforms the controlled fixture answers for; both are real Meta adapters. */
export const controlledProviderPlatforms = ["instagram", "threads"] as const;

/** One of the platforms the controlled fixture serves. */
type ControlledProviderPlatform = (typeof controlledProviderPlatforms)[number];

/**
 * One attachment as the controlled platform actually stored it: the checksum is
 * computed from the bytes read out of the ASSETS bucket, never from a value the
 * automation Worker claimed about them.
 */
interface ControlledPublicationMedia {
  /** Lowercase hex SHA-256 of the bytes stored under {@link key}. */
  checksum: string;
  contentType: string;
  fileSize: number;
  /** R2 key holding the stored bytes, relative to the shared assets bucket. */
  key: string;
}

/** Durable state of one publication the controlled platform accepted. */
interface ControlledPublicationState {
  /** `"published"` while the copy is live, `"cancelled"` after a real cancel. */
  state: "published" | "cancelled";
}

/** One live (or cancelled) copy the controlled platform holds for a Channel. */
export interface ControlledPublication extends ControlledPublicationState {
  accountId: string;
  caption: string;
  hashtags: string[];
  media: ControlledPublicationMedia[];
  operationId: string;
  platform: ControlledProviderPlatform;
  /** Provider-side publication identity reported back to the application. */
  publicationId: string;
  publishedAt: string;
}

/** Per-Channel scripted provider behaviour an acceptance test arms up front. */
export interface ControlledProviderScript {
  /**
   * Number of the next `publish` calls that must be answered with a retryable
   * `transient` failure. Each call decrements the counter by one, so arming
   * `1` produces exactly one visible `failed` outcome whose Distribution stays
   * retry-eligible, and the creator's own retry then succeeds.
   */
  failNextPublishes: number;
}

/** Everything the fixture entry injects into one Worker isolate. */
export interface ControlledProviderOptions {
  bucket: ControlledProviderBucket;
  now?: () => Date;
}

const retryPolicy: ProviderRetryPolicy = {
  baseDelaySeconds: 1,
  maxAttempts: 3,
  maxDelaySeconds: 5,
};

/**
 * Transfer modes the controlled adapters advertise.
 *
 * `byte_upload` is the only entry on purpose: it makes the automation Worker
 * hand over the real R2 object stream from the shared ASSETS bucket, so the
 * fixture stores exactly the processed rendition bytes the rest of the pipeline
 * verified, instead of a presigned URL it would have to fetch back later.
 */
const transferModes: readonly ProviderTransferMode[] = ["byte_upload"];

const fixtureClientId = "controlled-provider-client";
const fixtureClientSecret = "controlled-provider-secret";
const fixtureRedirectUri = "https://controlled-provider.invalid/oauth/callback";
const fixtureAuthorizationOrigin = "https://controlled-provider.invalid";

/**
 * Builds the R2 key holding one publication record.
 *
 * @param accountId - Provider-side account identity the publication belongs to.
 * @param publicationId - Provider-side publication identity.
 * @returns Fully qualified bucket key for the record.
 */
function controlledPublicationKey(accountId: string, publicationId: string): string {
  return `${controlledProviderPrefix}/publications/${encodeURIComponent(accountId)}/${encodeURIComponent(publicationId)}.json`;
}

/**
 * Builds the R2 key holding one stored attachment's bytes.
 *
 * @param publicationId - Provider-side publication identity that owns the copy.
 * @param index - Zero-based attachment position the Post arranged.
 * @returns Fully qualified bucket key for the attachment bytes.
 */
function controlledMediaKey(publicationId: string, index: number): string {
  return `${controlledProviderPrefix}/media/${encodeURIComponent(publicationId)}/${index}`;
}

/**
 * Builds the R2 key holding one Channel's scripted provider behaviour.
 *
 * @param accountId - Provider-side account identity the script applies to.
 * @returns Fully qualified bucket key for the script record.
 */
function controlledScriptKey(accountId: string): string {
  return `${controlledProviderPrefix}/scripts/${encodeURIComponent(accountId)}.json`;
}

/**
 * Lists every prefix of the controlled namespace, walking continuation pages so
 * a long acceptance run never silently reads a truncated prefix as "all copies".
 *
 * @param bucket - Shared assets bucket.
 * @param prefix - Prefix to enumerate.
 * @returns Every matching object key, in listing order.
 */
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

/**
 * Reads every publication the controlled platform holds for one Channel.
 *
 * @param bucket - Shared assets bucket.
 * @param accountId - Provider-side account identity to enumerate.
 * @returns Durable publication records, ordered by publication key.
 */
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

/**
 * Reads one Channel's scripted provider behaviour.
 *
 * @param bucket - Shared assets bucket.
 * @param accountId - Provider-side account identity the script applies to.
 * @returns The stored script, or `null` when the Channel is unarmed.
 */
export async function readControlledScript(
  bucket: ControlledProviderBucket,
  accountId: string,
): Promise<ControlledProviderScript | null> {
  const object = await bucket.get(controlledScriptKey(accountId));
  return object ? object.json<ControlledProviderScript>() : null;
}

/**
 * Arms one Channel's scripted provider behaviour.
 *
 * @param bucket - Shared assets bucket.
 * @param accountId - Provider-side account identity the script applies to.
 * @param script - Behaviour to persist; `null` disarms the Channel.
 * @returns The persisted script, or `null` when the Channel was disarmed.
 */
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

/**
 * Returns the production capability descriptor for one platform.
 *
 * The capability is read from the real adapter factory rather than restated
 * here, so `validatePublishInput`, media-count limits, caption limits, and the
 * `/platforms/capabilities` contract the acceptance run reads are the same
 * values production publishes. The fixture never issues provider HTTP, so the
 * placeholder OAuth credentials are never transmitted.
 *
 * @param platform - Platform whose real capability is required.
 * @returns The production capability for that platform.
 * @throws {TypeError} When the platform is not served by the controlled fixture.
 */
function controlledCapability(platform: Platform): PlatformCapability {
  const options = {
    clientId: fixtureClientId,
    clientSecret: fixtureClientSecret,
    redirectUri: fixtureRedirectUri,
  };
  const adapter =
    platform === "instagram"
      ? createInstagramAdapter(options)
      : platform === "threads"
        ? createThreadsAdapter(options)
        : undefined;
  if (!adapter) {
    throw new TypeError(`controlled provider does not serve ${platform}`);
  }
  return adapter.capability;
}

/**
 * Consumes one scripted failure for a Channel, if any is still armed.
 *
 * Read-modify-write is intentional: the counter is the acceptance test's only
 * control over the provider, and a single publish must consume exactly one.
 *
 * @param bucket - Shared assets bucket.
 * @param accountId - Provider-side account identity being published to.
 * @returns `true` when this publish must be answered with a retryable failure.
 */
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

/**
 * Reads a whole R2 object into memory for durable storage and digesting.
 *
 * The fixture stores each accepted attachment in full so the acceptance run can
 * prove byte equality independently; provider media is bounded by the same
 * capability ceilings production enforces.
 *
 * @param body - R2 object body stream.
 * @returns The stored bytes, freshly allocated over a standalone
 *   `ArrayBuffer` so downstream `BufferSource` consumers accept them.
 */
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

/**
 * Computes the lowercase hex SHA-256 digest of some bytes.
 *
 * @param bytes - Bytes to digest.
 * @returns 64-character lowercase hex digest.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Produces a standalone `ArrayBuffer` holding exactly the bytes a
 * `BufferSource` exposes.
 *
 * The structural bucket surface accepts only `ArrayBuffer | string`, matching
 * R2 `put`, while `readBody` yields a `Uint8Array` view whose backing buffer
 * may be shared or larger than the viewed range. Viewed bytes are copied into
 * a fresh `Uint8Array`, whose `.slice()` is typed `Uint8Array<ArrayBuffer>`;
 * its `.buffer` is therefore a standalone `ArrayBuffer` without casts.
 *
 * @param source - Viewed or raw bytes to copy.
 * @returns An `ArrayBuffer` containing exactly the source bytes.
 */
function toArrayBuffer(source: BufferSource): ArrayBuffer {
  const viewed = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  return viewed.slice().buffer;
}

/**
 * Builds the retryable provider failure a scripted Channel answers with.
 *
 * `transient` is deliberate: it normalizes to `retryable: true`, which is what
 * records `distributions.failure_retryable = true` so the acceptance run can
 * drive the creator-visible Retry affordance instead of a dead terminal state.
 *
 * @param accountId - Provider-side account identity whose script fired.
 * @returns The normalized failure descriptor.
 */
function scriptedFailure(accountId: string): ProviderFailure {
  return normalizeProviderFailure({
    classification: "transient",
    code: "controlled_provider_scripted_failure",
    message: `Controlled provider rejected one scripted attempt for ${accountId}`,
    retryable: true,
  });
}

/**
 * Resolves the controlled platform account a call targets.
 *
 * @param credentials - Credentials the automation Worker decrypted.
 * @returns The provider-side account identity.
 * @throws {TypeError} When the call carries no provider account identity.
 */
function requireAccountId(credentials: ProviderCredentials): string {
  const accountId = credentials.accountId?.trim();
  if (!accountId) {
    throw new TypeError("controlled provider call has no account identity");
  }
  return accountId;
}

/**
 * Builds one controlled adapter for a single platform.
 *
 * @param platform - Platform the adapter serves.
 * @param options - Shared bucket plus clock override.
 * @returns A complete {@link ProviderAdapter} that stores every accepted
 *   publication durably and answers lookups from that durable state.
 */
function createControlledAdapter(
  platform: ControlledProviderPlatform,
  options: ControlledProviderOptions,
): ProviderAdapter {
  const now = options.now ?? (() => new Date());
  const bucket = options.bucket;

  return {
    capability: controlledCapability(platform),

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
      // The controlled platform mints its own account identity from the code it
      // issued, so a connected Channel is a real provider-side account rather
      // than an application-invented row. Local acceptance provisions Channels
      // directly because the connect boundary requires an HTTPS provider origin.
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
      // Replies succeed unconditionally; the provider operation id is derived
      // from the target comment so assertions can correlate accepted replies.
      return {
        outcome: "confirmed_success" as const,
        providerOperationId: `controlled-reply:${replyInput.providerCommentId}`,
      };
    },

    retryPolicy,
    transferModes,
  };
}

/**
 * Builds the `ProviderRegistry` the fixture entries inject into both Workers.
 *
 * Both Workers receive the same registry instance shape so the API's published
 * capability contract and the automation Worker's publish behaviour can never
 * drift apart within one acceptance run. Platforms the fixture does not serve
 * stay unconfigured and therefore keep the production "not configured" stub
 * capabilities, exactly as a deployment without credentials behaves.
 *
 * @param options - Shared bucket plus clock override.
 * @returns A registry holding one controlled adapter per served platform.
 */
export function createControlledProviderRegistry(
  options: ControlledProviderOptions,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const platform of controlledProviderPlatforms) {
    registry.register(platform, createControlledAdapter(platform, options));
  }
  return registry;
}
