import {
  keepPreviousData,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type InfiniteData,
} from "@tanstack/react-query";
import { Cause, Effect, Exit } from "effect";
import { useEffect, useState } from "react";

import {
  ApiClientService,
  runFrontendEffect,
  runQueryEffect,
  type ApiClientError,
  type ApiClientServiceShape,
  type SessionScope,
  type WorkspaceService,
} from "./effect";
import { mutationFingerprint, useMutationKeyTracker } from "./mutation-idempotency";
import { analyticsRangeWindow } from "./analytics-range";
import { ApiError, getInvitationPreview } from "./api";
import { pollingInterval, privateCacheRetentionMs, referenceFreshnessMs } from "./query-defaults";
import type {
  AnalyticsRangePreset,
  AnalyticsPostScopeParams,
  AnalyticsScopeParams,
  AuditQueryParams,
  CalendarQueryParams,
  CalendarEvent,
  CreateBrandProfileInput,
  CreatePostInput,
  DiscoverySource,
  DistributionQueryParams,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformQueryParams,
  PostQueryParams,
  Post,
  PostListResponse,
  PublishingPreferencesUpdate,
  SchedulePostInput,
  CreateQueueInput,
  UpdateQueueInput,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  WorkspaceRole,
} from "@/types";

function normalizeParams<T extends object>(params: T | undefined) {
  if (params === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function withBrandProfile<T extends object>(
  scope: SessionScope,
  params?: T,
): (T & { brand_profile_id?: string }) | undefined {
  const brandProfileId =
    (params as { brand_profile_id?: string } | undefined)?.brand_profile_id ??
    scope.brandProfileId ??
    undefined;
  const merged = (
    brandProfileId === undefined ? { ...params } : { ...params, brand_profile_id: brandProfileId }
  ) as T & { brand_profile_id?: string };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

export const queryKeys = {
  currentUser: () => ["current-user"] as const,
  publishingPreferences: () => ["publishing-preferences"] as const,
  analytics: () => ["analytics"] as const,
  installation: () => ["installation"] as const,
  workspaceMembers: () => ["workspace-members"] as const,
  workspaceInvitations: () => ["workspace-invitations"] as const,
  onboarding: () => ["onboarding"] as const,
  reportingPolicy: () => ["reporting-policy"] as const,
  reportingFeedback: () => ["reporting-feedback"] as const,
  workspaceAudit: (params?: AuditQueryParams) =>
    params === undefined
      ? (["workspace-audit"] as const)
      : (["workspace-audit", normalizeParams(params)] as const),
  posts: (params?: PostQueryParams) =>
    params === undefined ? (["posts"] as const) : (["posts", normalizeParams(params)] as const),
  post: (id: string) => ["posts", id] as const,
  assets: () => ["assets"] as const,
  queues: (brandProfileId?: string) =>
    brandProfileId === undefined ? (["queues"] as const) : (["queues", brandProfileId] as const),
  brandProfiles: () => ["brand-profiles"] as const,
  asset: (id: string) => ["assets", id] as const,
  assetPreview: (id: string) => ["assets", id, "preview-url"] as const,
  platforms: (params?: PlatformQueryParams) =>
    params === undefined
      ? (["platforms", "accounts"] as const)
      : (["platforms", "accounts", normalizeParams(params)] as const),
  platformCapabilities: () => ["platforms", "capabilities"] as const,
  platformPublishingRequirements: (id: string) =>
    ["platforms", id, "publishing-requirements"] as const,
  oauthSelection: (selectionId: string) => ["oauth-selections", selectionId] as const,
  distributions: (params?: DistributionQueryParams) =>
    params === undefined
      ? (["distributions"] as const)
      : (["distributions", normalizeParams(params)] as const),
  distribution: (id: string) => ["distributions", id] as const,
  calendar: (params?: CalendarQueryParams) =>
    params === undefined
      ? (["calendar"] as const)
      : (["calendar", normalizeParams(params)] as const),
  analyticsDashboard: (params?: AnalyticsScopeParams) =>
    params === undefined
      ? (["analytics", "dashboard"] as const)
      : (["analytics", "dashboard", normalizeParams(params)] as const),
  analyticsPosts: (params?: AnalyticsPostScopeParams) =>
    params === undefined
      ? (["analytics", "posts"] as const)
      : (["analytics", "posts", normalizeParams(params)] as const),
};

function runApiQuery<A>(
  scope: SessionScope,
  operation: (api: ApiClientServiceShape) => Effect.Effect<A, ApiClientError, WorkspaceService>,
  signal?: AbortSignal,
): Promise<A> {
  return runFrontendEffect(
    scope,
    Effect.flatMap(ApiClientService, (api) => operation(api)),
    { signal },
  );
}

function brandProfileResourceInvalidations(): QueryKey[] {
  return [
    queryKeys.posts(),
    queryKeys.assets(),
    queryKeys.platforms(),
    queryKeys.distributions(),
    queryKeys.calendar(),
    queryKeys.queues(),
    queryKeys.analytics(),
  ];
}

function postResourceInvalidations(): QueryKey[] {
  return [
    queryKeys.posts(),
    queryKeys.distributions(),
    queryKeys.calendar(),
    queryKeys.assets(),
    queryKeys.analytics(),
  ];
}

export const mutationInvalidations = {
  queueConfiguration: () => [queryKeys.queues()],
  publishingPreferences: () => [queryKeys.publishingPreferences()],
  removePostFromQueue: () => [...postResourceInvalidations(), queryKeys.queues()],
  createPost: () => postResourceInvalidations(),
  updatePost: () => postResourceInvalidations(),
  deletePost: () => postResourceInvalidations(),
  schedulePost: () => postResourceInvalidations(),
  disconnectPlatform: (id: string) => [
    queryKeys.platforms(),
    queryKeys.platformPublishingRequirements(id),
    queryKeys.analytics(),
    queryKeys.workspaceAudit(),
  ],
  confirmOAuthSelection: () => [
    queryKeys.platforms(),
    queryKeys.analytics(),
    queryKeys.workspaceAudit(),
  ],
  updateDistribution: () => [
    queryKeys.posts(),
    queryKeys.distributions(),
    queryKeys.calendar(),
    queryKeys.analytics(),
  ],
  retryDistribution: () => [queryKeys.posts(), queryKeys.distributions(), queryKeys.calendar()],
  createBrandProfile: () => [queryKeys.brandProfiles(), queryKeys.workspaceAudit()],
  updateBrandProfile: () => [queryKeys.brandProfiles(), queryKeys.workspaceAudit()],
  deleteBrandProfile: () => [
    queryKeys.brandProfiles(),
    queryKeys.workspaceAudit(),
    ...brandProfileResourceInvalidations(),
  ],
  workspaceSettings: () => [
    queryKeys.installation(),
    queryKeys.workspaceMembers(),
    queryKeys.workspaceInvitations(),
    queryKeys.currentUser(),
    queryKeys.workspaceAudit(),
  ],
  reportingPreferences: () => [queryKeys.reportingPolicy(), queryKeys.workspaceAudit()],
  reportingFeedback: () => [queryKeys.reportingFeedback(), queryKeys.workspaceAudit()],
} satisfies Record<string, (...args: string[]) => QueryKey[]>;

export async function invalidateQueryKeys(queryClient: QueryClient, keys: QueryKey[]) {
  await Promise.all(
    keys.map(async (queryKey) => {
      if (queryKey.length === 1 && queryKey[0] === "analytics") {
        await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
        await queryClient.refetchQueries({ queryKey: ["analytics", "window"], type: "active" });
      } else {
        await queryClient.invalidateQueries({ queryKey });
      }
    }),
  );
}

function useIdempotentMutation<TVariables, TData>(
  scope: SessionScope,
  operation: (
    api: ApiClientServiceShape,
    variables: TVariables,
    idempotencyKey: string,
  ) => Effect.Effect<TData, ApiClientError, WorkspaceService>,
  invalidate?: (variables: TVariables) => QueryKey[],
) {
  const queryClient = useQueryClient();
  const idempotency = useMutationKeyTracker();

  return useMutation({
    mutationFn: (variables: TVariables) =>
      runApiQuery(scope, (api) => operation(api, variables, idempotency.keyFor(variables))),
    onSuccess: async (_data, variables) => {
      idempotency.clear(mutationFingerprint(variables));
      if (invalidate) await invalidateQueryKeys(queryClient, invalidate(variables));
    },
  });
}

export function useCurrentUser(scope: SessionScope) {
  return useQuery({
    queryKey: queryKeys.currentUser(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getCurrentUser(), signal),
    enabled: scope.isSignedIn,
  });
}

export function useBrandProfiles(scope: SessionScope) {
  return useQuery({
    queryKey: queryKeys.brandProfiles(),
    queryFn: ({ signal }) =>
      runApiQuery(
        scope,
        (api) => Effect.map(api.listBrandProfiles(), (res) => res.profiles),
        signal,
      ),
    enabled: scope.isSignedIn,
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
  });
}

export function useCreateBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreateBrandProfileInput, idempotencyKey) =>
      api.createBrandProfile(input, { idempotencyKey }),
    mutationInvalidations.createBrandProfile,
  );
}

export function useUpdateBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { profileId: string; input: UpdateBrandProfileInput }, idempotencyKey) =>
      api.updateBrandProfile(variables.profileId, variables.input, { idempotencyKey }),
    mutationInvalidations.updateBrandProfile,
  );
}

export function useDeleteBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, profileId: string, idempotencyKey) =>
      api.deleteBrandProfile(profileId, { idempotencyKey }),
    mutationInvalidations.deleteBrandProfile,
  );
}

export const POSTS_PAGE_SIZE = 60;

function selectPostPages(data: InfiniteData<PostListResponse, number>): Post[] {
  const posts = new Map<string, Post>();
  for (const page of data.pages) {
    for (const post of page.posts) {
      if (!posts.has(post.id)) posts.set(post.id, post);
    }
  }
  return [...posts.values()];
}

function isDueScheduled(
  item: { status: string; scheduled_at: string | null },
  now: number,
): boolean {
  return (
    item.status === "scheduled" &&
    item.scheduled_at !== null &&
    Date.parse(item.scheduled_at) <= now
  );
}

function useDueWorkClock(hasScheduled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!hasScheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [hasScheduled]);
  return now;
}

function readProgressDetails<A>(
  ids: readonly string[],
  read: (id: string) => Effect.Effect<A, ApiClientError, WorkspaceService>,
) {
  return Effect.gen(function* () {
    const exits = yield* Effect.forEach(ids, (id) => Effect.exit(read(id)), { concurrency: 4 });
    const values: A[] = [];
    const missing = new Set<string>();
    let error: Error | null = null;
    for (const [index, exit] of exits.entries()) {
      if (Exit.isSuccess(exit)) values.push(exit.value);
      else {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause);
        const failure = Cause.squash(exit.cause);
        if (failure instanceof ApiError && failure.status === 404) missing.add(ids[index]!);
        else error ??= failure instanceof Error ? failure : new Error("Progress read failed");
      }
    }
    return { values, missing, error };
  });
}

function newestPost(previous: Post | undefined, received: Post): Post {
  if (!previous) return received;
  if (previous.revision !== received.revision)
    return previous.revision > received.revision ? previous : received;
  if (Date.parse(previous.updated_at) > Date.parse(received.updated_at)) return previous;
  if (
    previous.distributions.some((old) =>
      received.distributions.some(
        (next) => old.id === next.id && Date.parse(old.updated_at) > Date.parse(next.updated_at),
      ),
    )
  )
    return previous;
  if (
    previous.attachments.some((old) =>
      received.attachments.some(
        (next) =>
          old.asset_id === next.asset_id &&
          Date.parse(old.asset.updated_at) > Date.parse(next.asset.updated_at),
      ),
    )
  )
    return previous;
  return received;
}

function usePostProgress(scope: SessionScope, posts: readonly Post[], collectionKey: QueryKey) {
  const queryClient = useQueryClient();
  const pageCount =
    queryClient.getQueryData<InfiniteData<PostListResponse, number>>(collectionKey)?.pages.length ??
    0;
  const hasScheduled = posts.some((post) =>
    post.distributions.some((distribution) => distribution.status === "scheduled"),
  );
  const now = useDueWorkClock(hasScheduled);
  const ids = posts
    .filter(
      (post) =>
        pollingInterval(post) !== false ||
        post.distributions.some((distribution) => isDueScheduled(distribution, now)),
    )
    .map((post) => post.id)
    .sort();
  const progress = useQuery({
    queryKey: ["post-progress", collectionKey],
    queryFn: async ({
      signal,
    }): Promise<{ values: Post[]; missing: Set<string>; error: Error | null }> => {
      if (ids.length > pageCount) {
        if (queryClient.getQueryState(collectionKey)?.fetchStatus === "fetching")
          return { values: [], missing: new Set<string>(), error: null };
        await queryClient.invalidateQueries(
          { queryKey: collectionKey, exact: true, refetchType: "active" },
          { throwOnError: true, cancelRefetch: false },
        );
        const refreshed =
          queryClient.getQueryData<InfiniteData<PostListResponse, number>>(collectionKey);
        const activeIds = new Set(ids);
        const values =
          refreshed?.pages.flatMap((page) => page.posts).filter((post) => activeIds.has(post.id)) ??
          [];
        const receivedIds = new Set(values.map((post) => post.id));
        const absent = ids.filter((id) => !receivedIds.has(id));
        const details =
          absent.length > 0
            ? await runApiQuery(
                scope,
                (api) => readProgressDetails(absent, (id) => api.getPost(id)),
                signal,
              )
            : { values: [], missing: new Set<string>(), error: null };
        values.push(...details.values);
        if (
          values.some((next) =>
            next.distributions.some(
              (distribution) =>
                distribution.status === "published" &&
                posts.some(
                  (previous) =>
                    previous.id === next.id &&
                    previous.distributions.some(
                      (old) => old.id === distribution.id && old.status !== "published",
                    ),
                ),
            ),
          )
        )
          void invalidateQueryKeys(queryClient, [queryKeys.analytics()]);
        return { values, missing: details.missing, error: details.error };
      }
      return runApiQuery(scope, (api) => readProgressDetails(ids, (id) => api.getPost(id)), signal);
    },
    enabled: scope.isSignedIn && ids.length > 0,
    refetchInterval: 10_000,
    staleTime: 10_000,
    gcTime: 0,
  });
  useEffect(() => {
    if (!progress.data) return;
    const { missing } = progress.data;
    const replacements = new Map(progress.data.values.map((post) => [post.id, post]));
    const collections = {
      queryKey: queryKeys.posts(),
      predicate: (query: { queryKey: QueryKey }) =>
        query.queryKey.includes("pages") || query.queryKey.includes("queue-calendar"),
    };
    let published = false;
    for (const [, snapshot] of queryClient.getQueriesData<InfiniteData<PostListResponse, number>>(
      collections,
    )) {
      for (const page of snapshot?.pages ?? []) {
        for (const previous of page.posts) {
          const received = replacements.get(previous.id);
          if (!received) continue;
          const next = newestPost(previous, received);
          replacements.set(next.id, next);
          published ||= next.distributions.some(
            (distribution) =>
              distribution.status === "published" &&
              previous.distributions.find((old) => old.id === distribution.id)?.status !==
                "published",
          );
        }
      }
    }
    for (const [id, post] of replacements) {
      replacements.set(id, newestPost(queryClient.getQueryData<Post>(queryKeys.post(id)), post));
    }
    for (const [key, previous] of queryClient.getQueriesData<
      InfiniteData<PostListResponse, number>
    >(collections)) {
      if (
        !previous?.pages.some((page) =>
          page.posts.some((post) => replacements.has(post.id) || missing.has(post.id)),
        )
      )
        continue;
      queryClient.setQueryData(
        key,
        {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            posts: page.posts
              .filter((post) => !missing.has(post.id))
              .map((post) => replacements.get(post.id) ?? post),
          })),
        },
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
    }
    for (const id of missing)
      queryClient.removeQueries({ queryKey: queryKeys.post(id), exact: true });
    for (const post of replacements.values())
      queryClient.setQueryData(queryKeys.post(post.id), post);
    const outcomes = new Map(
      [...replacements.values()].flatMap((post) =>
        post.distributions.map((distribution) => [distribution.id, distribution] as const),
      ),
    );
    for (const [key, previous] of queryClient.getQueriesData<CalendarEvent[]>({
      queryKey: queryKeys.calendar(),
    })) {
      if (!previous?.some((event) => outcomes.has(event.id) || missing.has(event.post_id)))
        continue;
      queryClient.setQueryData(
        key,
        previous
          .filter((event) => !missing.has(event.post_id))
          .map((event) => {
            const outcome = outcomes.get(event.id);
            if (!outcome || Date.parse(outcome.updated_at) < Date.parse(event.updated_at))
              return event;
            return {
              ...event,
              status: outcome.status,
              scheduled_at: outcome.scheduled_at,
              published_at: outcome.published_at,
              updated_at: outcome.updated_at,
            };
          }),
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
    }
    if (published) void invalidateQueryKeys(queryClient, [queryKeys.analytics()]);
  }, [progress.data, queryClient]);
  return ids.length > 0 ? (progress.error ?? progress.data?.error ?? null) : null;
}

export function usePosts(scope: SessionScope, params?: Omit<PostQueryParams, "limit" | "offset">) {
  const scopedParams = withBrandProfile(scope, params);
  const collectionKey = [...queryKeys.posts(scopedParams), "pages", POSTS_PAGE_SIZE] as const;
  const query = useInfiniteQuery({
    queryKey: collectionKey,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      runApiQuery(
        scope,
        (api) => api.listPosts({ ...scopedParams, limit: POSTS_PAGE_SIZE, offset: pageParam }),
        signal,
      ),
    getNextPageParam: (last) =>
      last.has_more && last.posts.length > 0 ? last.offset + POSTS_PAGE_SIZE : undefined,
    select: selectPostPages,
    gcTime: privateCacheRetentionMs,
    staleTime: 60_000,
    enabled: scope.isSignedIn,
  });
  const progressError = usePostProgress(scope, query.data ?? [], collectionKey);
  return { ...query, error: query.error ?? progressError };
}

export function usePost(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.post(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getPost(id), signal),
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
  });
}

export function useCreatePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreatePostInput, idempotencyKey) => api.createPost(input, { idempotencyKey }),
    mutationInvalidations.createPost,
  );
}

export function useUpdatePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdatePostInput }, idempotencyKey) =>
      api.updatePost(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.updatePost,
  );
}

export function useDeletePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; brandProfileId: string }, idempotencyKey) =>
      api.deletePost(variables.id, variables.brandProfileId, { idempotencyKey }),
    mutationInvalidations.deletePost,
  );
}

interface BulkDeleteFailure {
  id: string;
  message: string;
}

interface BulkDeleteOutcome {
  deletedIds: string[];
  failed: BulkDeleteFailure[];
}

const BULK_DELETE_CONCURRENCY = 4;

export interface DeletePostTarget {
  id: string;
  brandProfileId: string;
}

function deletionFailureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

export function runBulkDelete(
  deleteOne: (
    target: DeletePostTarget,
    idempotencyKey: string,
  ) => Effect.Effect<unknown, ApiClientError, WorkspaceService>,
  targets: readonly DeletePostTarget[],
  idempotencyKey: string,
): Effect.Effect<BulkDeleteOutcome, never, WorkspaceService> {
  return Effect.forEach(
    targets,
    (target, index) => Effect.exit(deleteOne(target, `${idempotencyKey}:${index}`)),
    { concurrency: BULK_DELETE_CONCURRENCY },
  ).pipe(
    Effect.map((exits) => {
      const deletedIds: string[] = [];
      const failed: BulkDeleteFailure[] = [];
      exits.forEach((exit, index) => {
        const target = targets[index]!;
        if (Exit.isSuccess(exit)) {
          deletedIds.push(target.id);
        } else {
          failed.push({
            id: target.id,
            message: deletionFailureMessage(Cause.squash(exit.cause)),
          });
        }
      });
      return { deletedIds, failed };
    }),
  );
}

export function useDeletePostsBatch(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { targets: readonly DeletePostTarget[] }, idempotencyKey) =>
      runBulkDelete(
        (target, itemKey) =>
          api.deletePost(target.id, target.brandProfileId, { idempotencyKey: itemKey }),
        variables.targets,
        idempotencyKey,
      ),
    mutationInvalidations.deletePost,
  );
}

export function useSchedulePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: SchedulePostInput }, idempotencyKey) =>
      api.schedulePost(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.schedulePost,
  );
}
export function useQueues(scope: SessionScope, brandProfileId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.queues(brandProfileId ?? ""),
    initialPageParam: undefined as string | undefined,
    queryFn:
      brandProfileId === null
        ? skipToken
        : ({ pageParam, signal }) =>
            runApiQuery(
              scope,
              (api) =>
                api.listQueues({
                  brand_profile_id: brandProfileId,
                  limit: 50,
                  ...(pageParam ? { cursor: pageParam } : {}),
                }),
              signal,
            ),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: scope.isSignedIn && enabled,
  });
}

export function useQueueCalendarPosts(scope: SessionScope, params: PostQueryParams) {
  const collectionKey = [...queryKeys.posts(params), "queue-calendar"] as const;
  const query = useInfiniteQuery({
    queryKey: collectionKey,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      runApiQuery(
        scope,
        (api) => api.listPosts({ ...params, limit: 100, offset: pageParam }),
        signal,
      ),
    getNextPageParam: (page) => (page.has_more ? page.offset + page.limit : undefined),
    enabled: scope.isSignedIn,
  });
  const progressError = usePostProgress(
    scope,
    query.data?.pages.flatMap((page) => page.posts) ?? [],
    collectionKey,
  );
  return { ...query, error: query.error ?? progressError };
}

export function usePublishingPreferences(scope: SessionScope, enabled = true) {
  return useQuery({
    queryKey: queryKeys.publishingPreferences(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getPublishingPreferences(), signal),
    enabled: scope.isSignedIn && enabled,
    staleTime: referenceFreshnessMs,
  });
}

export function useUpdatePublishingPreferences(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: PublishingPreferencesUpdate, idempotencyKey) =>
      api.updatePublishingPreferences(input, { idempotencyKey }),
    mutationInvalidations.publishingPreferences,
  );
}

export function useCreateQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreateQueueInput, idempotencyKey) => api.createQueue(input, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

export function useUpdateQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdateQueueInput }, idempotencyKey) =>
      api.updateQueue(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

export function useDeleteQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; brandProfileId: string }, idempotencyKey) =>
      api.deleteQueue(variables.id, variables.brandProfileId, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

export function useRemovePostFromQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { queueId: string; postId: string; brandProfileId: string }, idempotencyKey) =>
      api.removePostFromQueue(variables.queueId, variables.postId, variables.brandProfileId, {
        idempotencyKey,
      }),
    mutationInvalidations.removePostFromQueue,
  );
}

export function useAsset(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.asset(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getAsset(id), signal),
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
  });
}

export function useAssetPreviewUrl(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.assetPreview(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getAssetPreviewUrl(id), signal),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
    staleTime: 10 * 60 * 1_000,
  });
}

export function usePlatforms(
  scope: SessionScope,
  options: { enabled?: boolean; brandProfileId?: string | null } = {},
) {
  const { enabled = true, brandProfileId } = options;
  const effectiveProfileId = brandProfileId === undefined ? scope.brandProfileId : brandProfileId;
  const params: PlatformQueryParams | undefined =
    effectiveProfileId == null ? undefined : { brand_profile_id: effectiveProfileId };
  return useQuery({
    queryKey: queryKeys.platforms(params),
    queryFn: ({ signal }) =>
      runApiQuery(
        scope,
        (api) => Effect.map(api.listPlatforms(params), (res) => res.accounts),
        signal,
      ),
    placeholderData: keepPreviousData,
    enabled: scope.isSignedIn && enabled,
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
  });
}

export function usePlatformCapabilities(scope: SessionScope) {
  return useQuery({
    queryKey: queryKeys.platformCapabilities(),
    queryFn: ({ signal }) =>
      runApiQuery(
        scope,
        (api) => Effect.map(api.listPlatformCapabilities(), (res) => res.capabilities),
        signal,
      ),
    enabled: scope.isSignedIn,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useBroadcastControls(scope: SessionScope) {
  const end = useIdempotentMutation(
    scope,
    (api, id: string, key) => api.endBroadcast(id, { idempotencyKey: key }),
    () => [queryKeys.posts(), queryKeys.distributions(), queryKeys.calendar()],
  );
  return {
    read: (id: string, signal?: AbortSignal) =>
      runApiQuery(scope, (api) => api.getBroadcast(id, { signal }), signal),
    end,
  };
}

export function usePlatformPublishingRequirements(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.platformPublishingRequirements(id),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.getPlatformPublishingRequirements(id), signal),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
    staleTime: 0,
  });
}

export function useDisconnectPlatform(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.disconnectPlatform(id, { idempotencyKey }),
    mutationInvalidations.disconnectPlatform,
  );
}

export function useStartPlatformOAuth(scope: SessionScope) {
  return useMutation({
    mutationFn: (variables: { platform: Platform }) =>
      runApiQuery(scope, (api) => api.startPlatformOAuth(variables.platform)),
  });
}

export function useOAuthSelection(scope: SessionScope, selectionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.oauthSelection(selectionId),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.getOAuthSelection(selectionId), signal),
    enabled: scope.isSignedIn && selectionId.length > 0 && enabled,
    staleTime: 0,
    retry: false,
  });
}

export function useConfirmOAuthSelection(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (
      api,
      variables: { selectionId: string; input: OAuthSelectionConfirmRequest },
      idempotencyKey,
    ) => api.confirmOAuthSelection(variables.selectionId, variables.input, { idempotencyKey }),
    mutationInvalidations.confirmOAuthSelection,
  );
}

export function useCancelOAuthSelection(scope: SessionScope) {
  return useIdempotentMutation(scope, (api, selectionId: string, idempotencyKey) =>
    api.cancelOAuthSelection(selectionId, { idempotencyKey }),
  );
}

export function useRetryDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.retryDistribution(id, { idempotencyKey }),
    mutationInvalidations.retryDistribution,
  );
}

export function useUpdateScheduledDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdateDistributionInput }, idempotencyKey) =>
      api.updateScheduledDistribution(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.updateDistribution,
  );
}

export function useCancelDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.cancelDistribution(id, { idempotencyKey }),
    mutationInvalidations.updateDistribution,
  );
}

function useCalendarProgress(
  scope: SessionScope,
  events: readonly CalendarEvent[],
  collectionKey: QueryKey,
) {
  const queryClient = useQueryClient();
  const now = useDueWorkClock(events.some((event) => event.status === "scheduled"));
  const ids = events
    .filter((event) => pollingInterval(event) !== false || isDueScheduled(event, now))
    .map((event) => event.id)
    .sort();
  const progress = useQuery({
    queryKey: ["calendar-progress", collectionKey],
    queryFn: async ({ signal }) => {
      if (ids.length > 1) {
        await queryClient.invalidateQueries(
          { queryKey: collectionKey, exact: true, refetchType: "active" },
          { throwOnError: true },
        );
        const refreshed = queryClient.getQueryData<CalendarEvent[]>(collectionKey) ?? [];
        if (
          events.some((previous) =>
            refreshed.some((next) => next.id === previous.id && next.status !== previous.status),
          )
        ) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.posts(), refetchType: "none" });
          void invalidateQueryKeys(queryClient, [queryKeys.analytics()]);
        }
        return { values: [], missing: new Set<string>(), error: null };
      }
      return runApiQuery(
        scope,
        (api) => readProgressDetails(ids, (id) => api.getDistribution(id)),
        signal,
      );
    },
    enabled: scope.isSignedIn && ids.length > 0,
    refetchInterval: 10_000,
    staleTime: 10_000,
    gcTime: 0,
  });
  useEffect(() => {
    if (!progress.data) return;
    const { missing } = progress.data;
    const replacements = new Map(
      progress.data.values.map((distribution) => [distribution.id, distribution]),
    );
    let published = false;
    let changed = false;
    for (const [key, previous] of queryClient.getQueriesData<CalendarEvent[]>({
      queryKey: queryKeys.calendar(),
    })) {
      if (!previous?.some((event) => replacements.has(event.id) || missing.has(event.id))) continue;
      queryClient.setQueryData(
        key,
        previous
          .filter((event) => !missing.has(event.id))
          .map((event) => {
            const replacement = replacements.get(event.id);
            if (!replacement || Date.parse(replacement.updated_at) < Date.parse(event.updated_at))
              return event;
            if (replacement.status !== event.status) {
              changed = true;
              published ||= replacement.status === "published";
            }
            return {
              ...event,
              status: replacement.status,
              scheduled_at: replacement.scheduled_at,
              published_at: replacement.published_at,
              updated_at: replacement.updated_at,
            };
          }),
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
    }
    if (changed)
      void queryClient.invalidateQueries({ queryKey: queryKeys.posts(), refetchType: "none" });
    if (published) void invalidateQueryKeys(queryClient, [queryKeys.analytics()]);
  }, [progress.data, queryClient]);
  return ids.length > 0 ? (progress.error ?? progress.data?.error ?? null) : null;
}

export function useCalendar(scope: SessionScope, params?: CalendarQueryParams) {
  const scopedParams = params ? withBrandProfile(scope, params) : undefined;
  const collectionKey = queryKeys.calendar(scopedParams);
  const query = useQuery({
    queryKey: collectionKey,
    queryFn: scopedParams
      ? ({ signal }) =>
          runApiQuery(
            scope,
            (api) => Effect.map(api.getCalendar(scopedParams), (res) => res.events),
            signal,
          )
      : skipToken,
    enabled: scope.isSignedIn,
  });
  const progressError = useCalendarProgress(scope, query.data ?? [], collectionKey);
  return { ...query, error: query.error ?? progressError };
}

export function useInstallation(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.installation(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getInstallation(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

function useAnalyticsWindow(scope: SessionScope, range: AnalyticsRangePreset) {
  return useQuery({
    queryKey: ["analytics", "window", range],
    queryFn: () => ({ ...analyticsRangeWindow(range), generation: crypto.randomUUID() }),
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
    enabled: scope.isSignedIn,
  });
}

export function useAnalyticsDashboard(scope: SessionScope, params: AnalyticsScopeParams) {
  const window = useAnalyticsWindow(scope, params.range).data;
  const scopedParams = withBrandProfile(scope, {
    account_id: params.account_id,
    format: params.format,
    platform: params.platform,
  });
  const keyParams = { ...scopedParams, range: params.range };
  return useQuery({
    queryKey: [...queryKeys.analyticsDashboard(keyParams), window?.generation],
    queryFn: window
      ? ({ signal }) =>
          runApiQuery(
            scope,
            (api) =>
              api.getAnalyticsDashboard({ ...scopedParams, start: window.start, end: window.end }),
            signal,
          )
      : skipToken,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey.at(-1) === window?.generation ? previous : undefined,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
    enabled: scope.isSignedIn,
  });
}

export function usePostAnalyticsHistory(scope: SessionScope, distributionIds: readonly string[]) {
  const ids = [...distributionIds].sort();
  return useQuery({
    queryKey: ["posts", "analytics-history", scope.workspaceId, ids],
    queryFn: ({ signal }) =>
      runApiQuery(
        scope,
        (api) => Effect.forEach(ids, (id) => api.getDistributionAnalytics(id), { concurrency: 4 }),
        signal,
      ),
    staleTime: 60_000,
    enabled: scope.isSignedIn && ids.length > 0,
  });
}

export function useWorkspaceMembers(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceMembers(),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.listWorkspaceMembers(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useAnalyticsPosts(scope: SessionScope, params: AnalyticsPostScopeParams) {
  const window = useAnalyticsWindow(scope, params.range).data;
  const { range, ...filters } = params;
  const scopedParams = withBrandProfile(scope, filters);
  const keyParams: AnalyticsPostScopeParams = {
    account_id: scopedParams?.account_id,
    brand_profile_id: scopedParams?.brand_profile_id,
    format: scopedParams?.format,
    limit: params.limit,
    metric: params.metric,
    offset: params.offset,
    platform: params.platform,
    range,
  };
  return useQuery({
    queryKey: [...queryKeys.analyticsPosts(keyParams), window?.generation],
    queryFn: window
      ? ({ signal }) =>
          runApiQuery(
            scope,
            (api) =>
              api.getAnalyticsPosts({ ...scopedParams, start: window.start, end: window.end }),
            signal,
          )
      : skipToken,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey.at(-1) === window?.generation ? previous : undefined,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
    enabled: scope.isSignedIn,
  });
}

export function useWorkspaceInvitations(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceInvitations(),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.listWorkspaceInvitations(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useWorkspaceAudit(
  scope: SessionScope,
  workspaceId: string,
  params: AuditQueryParams,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.workspaceAudit(params),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.listWorkspaceAudit(workspaceId, params), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useCreateWorkspaceInvitation(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; email: string; role: WorkspaceRole }, key) =>
      api.createWorkspaceInvitation(
        variables.workspaceId,
        { email: variables.email, role: variables.role },
        { idempotencyKey: key },
      ),
    mutationInvalidations.workspaceSettings,
  );
}

export function useResendWorkspaceInvitation(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; invitationId: string }, key) =>
      api.resendWorkspaceInvitation(variables.workspaceId, variables.invitationId, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useRevokeWorkspaceInvitation(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; invitationId: string }, key) =>
      api.revokeWorkspaceInvitation(variables.workspaceId, variables.invitationId, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useUpdateWorkspaceMember(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; memberId: string; role: WorkspaceRole }, key) =>
      api.updateWorkspaceMember(variables.workspaceId, variables.memberId, variables.role, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useRemoveWorkspaceMember(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; memberId: string }, key) =>
      api.removeWorkspaceMember(variables.workspaceId, variables.memberId, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useSuspendInstallationMember(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; memberId: string; reason?: string }, key) =>
      api.suspendInstallationMember(variables.workspaceId, variables.memberId, variables.reason, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useReactivateInstallationMember(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; memberId: string }, key) =>
      api.reactivateInstallationMember(variables.workspaceId, variables.memberId, {
        idempotencyKey: key,
      }),
    mutationInvalidations.workspaceSettings,
  );
}

export function useDeleteInstallationMember(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; memberId: string; confirmEmail: string }, key) =>
      api.deleteInstallationMember(
        variables.workspaceId,
        variables.memberId,
        variables.confirmEmail,
        { idempotencyKey: key },
      ),
    mutationInvalidations.workspaceSettings,
  );
}

export function useTransferInstallationOwnership(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; targetUserId: string; password: string }, key) =>
      api.transferInstallationOwnership(
        variables.workspaceId,
        variables.targetUserId,
        variables.password,
        { idempotencyKey: key },
      ),
    mutationInvalidations.workspaceSettings,
  );
}

export function useRenameWorkspace(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { workspaceId: string; name: string }, key) =>
      api.updateWorkspaceName(
        variables.workspaceId,
        { name: variables.name },
        {
          idempotencyKey: key,
        },
      ),
    mutationInvalidations.workspaceSettings,
  );
}

export function useAcceptWorkspaceInvitation(scope: SessionScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      runApiQuery(scope, (api) => api.acceptWorkspaceInvitation(token)),
    onSuccess: async () => {
      await invalidateQueryKeys(queryClient, mutationInvalidations.workspaceSettings());
    },
  });
}

export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: ["invitation-preview", token],
    queryFn:
      token !== null && token.length >= 16
        ? ({ signal }) => runQueryEffect(getInvitationPreview(token), { signal })
        : skipToken,
  });
}

export function useOnboarding(scope: SessionScope, enabled = true) {
  return useQuery({
    queryKey: queryKeys.onboarding(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getOnboarding(), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useSaveOnboarding(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: { step: "improvement" | "ready" }, idempotencyKey) =>
      api.saveOnboarding(input, { idempotencyKey }),
    () => [queryKeys.onboarding()],
  );
}

export function useCompleteOnboarding(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, _input: Record<string, never>, idempotencyKey) =>
      api.completeOnboarding({ idempotencyKey }),
    () => [queryKeys.onboarding()],
  );
}

export function useReportingPolicy(scope: SessionScope, enabled = true) {
  return useQuery({
    queryKey: queryKeys.reportingPolicy(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getReportingPolicy(), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useUpdateReportingPreferences(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: { diagnostics: boolean; usage: boolean }, idempotencyKey) =>
      api.updateReportingPreferences(input, { idempotencyKey }),
    mutationInvalidations.reportingPreferences,
  );
}

export function useReportingFeedback(scope: SessionScope, enabled = true) {
  return useQuery({
    queryKey: queryKeys.reportingFeedback(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getReportingFeedback(), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

export function useSubmitReportingFeedback(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: { discoverySource: DiscoverySource }, idempotencyKey) =>
      api.submitReportingFeedback({ discovery_source: input.discoverySource }, { idempotencyKey }),
    mutationInvalidations.reportingFeedback,
  );
}
