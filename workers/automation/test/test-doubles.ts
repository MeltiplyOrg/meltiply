import type { EffectTransactionClient } from "@meltiply/database";
import {
  unavailableCapabilities,
  type DatabaseError,
  type Platform,
  type PlatformCapability,
} from "@meltiply/domain";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";
import type { ObjectStore, ObjectUrlSigner } from "@meltiply/storage";
import { Effect } from "effect";

import type { withSystemTransactionEffect } from "../src/database";
import type { AutomationEnv } from "../src/env";
import type { ReplyWorkflowPayload } from "../src/messages";

export type FakeQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rowCount?: number | null;
  rows: Row[];
};

export type FakeQueryHandler = (
  text: string,
  values?: readonly unknown[],
) => Effect.Effect<FakeQueryResult, DatabaseError>;

function unstubbed(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} is not stubbed`);
  };
}

export function fakeTransactionClient(handler: FakeQueryHandler): EffectTransactionClient {
  return {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) =>
      Effect.map(handler(text, values), (result) => ({
        command: "",
        fields: [],
        oid: 0,
        rowCount: result.rowCount ?? result.rows.length,
        rows: result.rows as Row[],
      })),
  };
}

export function fakeSystemTransaction(
  handler: FakeQueryHandler,
): typeof withSystemTransactionEffect {
  const client = fakeTransactionClient(handler);
  return <A, E, R>(
    _env: AutomationEnv,
    operation: (tx: EffectTransactionClient) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseError, R> => operation(client);
}

const emptyQueueMetrics = {
  backlogBytes: 0,
  backlogCount: 0,
};

export function fakeQueue(overrides?: {
  metrics?: Queue<unknown>["metrics"];
  send?: (message: unknown, options?: QueueSendOptions) => Promise<unknown>;
  sendBatch?: (
    messages: Iterable<MessageSendRequest<unknown>>,
    options?: QueueSendBatchOptions,
  ) => Promise<unknown>;
}): Queue<unknown> {
  return {
    metrics: overrides?.metrics ?? (async () => emptyQueueMetrics),
    send: async (message, options) => {
      if (overrides?.send) {
        await (options !== undefined ? overrides.send(message, options) : overrides.send(message));
      }
      return { metadata: { metrics: emptyQueueMetrics } };
    },
    sendBatch: async (messages, options) => {
      if (overrides?.sendBatch) {
        await (options !== undefined
          ? overrides.sendBatch(messages, options)
          : overrides.sendBatch(messages));
      }
      return { metadata: { metrics: emptyQueueMetrics } };
    },
  };
}

export function fakeR2Object(overrides?: Partial<R2Object>): R2Object {
  return {
    checksums: { toJSON: () => ({}) },
    etag: "etag-1",
    httpEtag: '"etag-1"',
    httpMetadata: { contentType: "video/mp4" },
    key: "org-1/asset-1/video.mp4",
    size: 512,
    storageClass: "Standard",
    uploaded: new Date("2026-07-19T00:00:00.000Z"),
    version: "version-1",
    writeHttpMetadata: () => undefined,
    ...overrides,
  };
}

export function fakeR2ObjectBody(
  body: ReadableStream<Uint8Array>,
  overrides?: Partial<R2Object>,
): R2ObjectBody {
  const base = fakeR2Object(overrides);
  const notStubbed = unstubbed("R2ObjectBody");
  return {
    ...base,
    arrayBuffer: notStubbed,
    blob: notStubbed,
    body,
    bodyUsed: false,
    bytes: notStubbed,
    json: notStubbed,
    text: notStubbed,
    writeHttpMetadata: base.writeHttpMetadata,
  };
}

export function fakeR2Bucket(overrides?: {
  delete?: R2Bucket["delete"];
  get?: (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>;
  head?: (key: string) => Promise<R2Object | null>;
  list?: R2Bucket["list"];
  put?: (
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ) => Promise<R2Object>;
}): R2Bucket {
  const notStubbed = unstubbed("R2Bucket");
  const get = overrides?.get ?? notStubbed;
  const put = overrides?.put ?? notStubbed;
  return {
    createMultipartUpload: notStubbed,
    delete: overrides?.delete ?? (async () => undefined),
    get,
    head: overrides?.head ?? (async () => null),
    list: overrides?.list ?? notStubbed,
    put: put as R2Bucket["put"],
    resumeMultipartUpload: () => {
      throw new Error("R2Bucket.resumeMultipartUpload is not stubbed");
    },
  };
}

export function fakeObjectStore(overrides?: Partial<ObjectStore>): ObjectStore {
  const notStubbed = unstubbed("ObjectStore");
  return {
    copyObject: overrides?.copyObject ?? notStubbed,
    createMultipartUpload: overrides?.createMultipartUpload ?? notStubbed,
    delete: overrides?.delete ?? (async () => undefined),
    head: overrides?.head ?? (async () => null),
    readPrefix: overrides?.readPrefix ?? (async () => null),
    resumeMultipartUpload:
      overrides?.resumeMultipartUpload ??
      (() => {
        throw new Error("ObjectStore.resumeMultipartUpload is not stubbed");
      }),
    ...(overrides?.read ? { read: overrides.read } : {}),
    ...(overrides?.readRange ? { readRange: overrides.readRange } : {}),
  };
}

export function fakeObjectUrlSigner(overrides?: Partial<ObjectUrlSigner>): ObjectUrlSigner {
  const notStubbed = unstubbed("ObjectUrlSigner");
  return {
    signDownload: overrides?.signDownload ?? notStubbed,
    signMultipartPart: overrides?.signMultipartPart ?? notStubbed,
    signUpload: overrides?.signUpload ?? notStubbed,
  };
}

export function fakePlatformCapability(
  platform: Platform,
  overrides: Partial<PlatformCapability> = {},
): PlatformCapability {
  const base = unavailableCapabilities().find((item) => item.platform === platform)!;
  return { ...base, ...overrides };
}

export function fakeProviderAdapter(
  platform: Platform,
  overrides: Partial<ProviderAdapter> = {},
): ProviderAdapter {
  return {
    capability: fakePlatformCapability(platform),
    transferModes: [],
    ...overrides,
  };
}

export function fakeProviderRegistry(
  adapters: Partial<Record<Platform, ProviderAdapter>>,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [platform, adapter] of Object.entries(adapters) as Array<
    [Platform, ProviderAdapter | undefined]
  >) {
    if (adapter) registry.register(platform, adapter);
  }
  return registry;
}

export function fakeReplyWorkflow(
  createBatch: (
    batch: WorkflowInstanceCreateOptions<ReplyWorkflowPayload>[],
  ) => Promise<WorkflowInstance[]>,
): Workflow<ReplyWorkflowPayload> {
  const notStubbed = unstubbed("Workflow");
  return {
    create: notStubbed,
    createBatch: createBatch as Workflow<ReplyWorkflowPayload>["createBatch"],
    deleteBatch: notStubbed,
    get: notStubbed,
  };
}
