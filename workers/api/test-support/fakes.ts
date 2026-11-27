import type { EffectTransactionClient, Pool, TransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import type { StorageServiceShape } from "@meltiply/storage";
import type { Effect } from "effect";

import type { BrandProfileApiService } from "../src/brand-profile-service";
import type { CoreApiService } from "../src/core-types";
import type { runWorkerEffect } from "../src/effect/runtime";
import type { ApiWorkerEnv, OAuthStateStub } from "../src/env";

function unimplemented(name: string): () => never {
  return () => {
    throw new Error(`unexpected test double call: ${name}`);
  };
}

export function fakeEnv(overrides: Partial<ApiWorkerEnv> = {}): ApiWorkerEnv {
  return {
    ENVIRONMENT: "test",
    VERSION: "test",
    ...overrides,
  };
}

export function fakeBrandProfileService(
  overrides: Partial<BrandProfileApiService> = {},
): BrandProfileApiService {
  return {
    createBrandProfile: unimplemented("createBrandProfile"),
    deleteBrandProfile: unimplemented("deleteBrandProfile"),
    getBrandProfile: unimplemented("getBrandProfile"),
    listBrandProfiles: unimplemented("listBrandProfiles"),
    listDeletedBrandProfiles: unimplemented("listDeletedBrandProfiles"),
    restoreBrandProfile: unimplemented("restoreBrandProfile"),
    updateBrandProfile: unimplemented("updateBrandProfile"),
    ...overrides,
  };
}

export function fakeCoreService(overrides: Partial<CoreApiService> = {}): CoreApiService {
  return {
    analyticsPosts: unimplemented("analyticsPosts"),
    calendar: unimplemented("calendar"),
    cancelDistribution: unimplemented("cancelDistribution"),
    dashboardAnalytics: unimplemented("dashboardAnalytics"),
    disconnectPlatform: unimplemented("disconnectPlatform"),
    distributionAnalytics: unimplemented("distributionAnalytics"),
    getDistribution: unimplemented("getDistribution"),
    inbox: unimplemented("inbox"),
    listDistributions: unimplemented("listDistributions"),
    listPlatformAccounts: unimplemented("listPlatformAccounts"),
    platformCapabilities: unimplemented("platformCapabilities"),
    replyToComment: unimplemented("replyToComment"),
    retryDistribution: unimplemented("retryDistribution"),
    summaryAnalytics: unimplemented("summaryAnalytics"),
    updateDistribution: unimplemented("updateDistribution"),
    ...overrides,
  };
}

export function fakeStorageService(
  overrides: Partial<StorageServiceShape> = {},
): StorageServiceShape {
  return {
    createMultipartUpload: unimplemented("createMultipartUpload"),
    delete: unimplemented("delete"),
    getMetadata: unimplemented("getMetadata"),
    head: unimplemented("head"),
    readPrefix: unimplemented("readPrefix"),
    readRange: unimplemented("readRange"),
    resumeMultipartUpload: unimplemented("resumeMultipartUpload"),
    signDownload: unimplemented("signDownload"),
    signMultipartPart: unimplemented("signMultipartPart"),
    signUpload: unimplemented("signUpload"),
    ...overrides,
  };
}

type QueryOutput = Effect.Success<ReturnType<EffectTransactionClient["query"]>>;

export function fakeTransactionClient(
  handler: (
    text: string,
    values?: readonly unknown[],
  ) => Effect.Effect<{ rows: readonly object[]; rowCount?: number | null }, DatabaseError>,
): EffectTransactionClient {
  return {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) =>
      handler(text, values) as Effect.Effect<
        Omit<QueryOutput, "rows"> & { rows: Row[] },
        DatabaseError
      >,
  };
}

export function fakeDurableObjectNamespace<Stub extends Rpc.DurableObjectBranded>(
  implementation: Partial<Record<keyof DurableObjectNamespace<Stub>, unknown>>,
): DurableObjectNamespace<Stub> {
  return {
    get: unimplemented("DurableObjectNamespace.get"),
    getByName: unimplemented("DurableObjectNamespace.getByName"),
    idFromName: unimplemented("DurableObjectNamespace.idFromName"),
    idFromString: unimplemented("DurableObjectNamespace.idFromString"),
    jurisdiction: unimplemented("DurableObjectNamespace.jurisdiction"),
    newUniqueId: unimplemented("DurableObjectNamespace.newUniqueId"),
    ...implementation,
  } as DurableObjectNamespace<Stub>;
}

export function fakeOAuthStateNamespace(
  stub: Partial<OAuthStateStub> | ((name: string) => Partial<OAuthStateStub>),
): DurableObjectNamespace<OAuthStateStub> {
  return fakeDurableObjectNamespace<OAuthStateStub>({
    getByName: typeof stub === "function" ? stub : () => stub,
  });
}

export function fakeR2Bucket(overrides: Partial<Record<keyof R2Bucket, unknown>>): R2Bucket {
  return {
    createMultipartUpload: unimplemented("R2Bucket.createMultipartUpload"),
    delete: unimplemented("R2Bucket.delete"),
    get: unimplemented("R2Bucket.get"),
    head: unimplemented("R2Bucket.head"),
    list: unimplemented("R2Bucket.list"),
    put: unimplemented("R2Bucket.put"),
    resumeMultipartUpload: unimplemented("R2Bucket.resumeMultipartUpload"),
    ...overrides,
  } as R2Bucket;
}

export function fakeExecutionContext(
  overrides: {
    passThroughOnException?: () => void;
    props?: Record<string, unknown>;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): ExecutionContext {
  return {
    passThroughOnException: overrides.passThroughOnException ?? (() => undefined),
    props: overrides.props ?? {},
    waitUntil: overrides.waitUntil ?? (() => undefined),
  } as ExecutionContext;
}

export function fakeHonoContext(options: {
  readonly actor?: unknown;
  readonly env?: Partial<ApiWorkerEnv>;
  readonly executionCtx?: {
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  };
  readonly path?: string;
  readonly requestId?: string;
  readonly session?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}): Parameters<typeof runWorkerEffect>[0] {
  const store = new Map<string, unknown>([
    ["requestId", options.requestId ?? "test-req-id"],
    ["traceId", options.traceId ?? "test-trace-id"],
  ]);
  if (options.actor !== undefined) store.set("actor", options.actor);
  if (options.session !== undefined) store.set("session", options.session);
  const context: unknown = {
    env: fakeEnv(options.env),
    executionCtx: options.executionCtx,
    get: (key: string) => store.get(key),
    req: { path: options.path, raw: { signal: options.signal } },
    set: (key: string, value: unknown) => store.set(key, value),
  };
  return context as Parameters<typeof runWorkerEffect>[0];
}

export function wrapPoolConnect(
  pool: Pool,
  wrap: (connect: () => Promise<TransactionClient>) => () => Promise<TransactionClient>,
): () => void {
  const original = pool.connect.bind(pool) as () => Promise<TransactionClient>;
  const target: { connect: () => Promise<TransactionClient> } = pool;
  const saved = target.connect;
  target.connect = wrap(original);
  return () => {
    target.connect = saved;
  };
}
