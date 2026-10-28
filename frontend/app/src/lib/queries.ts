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
  type ApiClientError,
  type ApiClientServiceShape,
  type SessionScope,
  type WorkspaceService,
} from "./effect";
import { useMutationKeyTracker } from "./mutation-idempotency";
import { analyticsRangeWindow } from "./analytics-range";
import { ApiError } from "./api";
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
  DistributionQueryParams,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformQueryParams,
  PostQueryParams,
  Post,
  PostListResponse,
  SchedulePostInput,
  CreateQueueInput,
  UpdateQueueInput,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  WorkspaceRole,
} from "@/types";

/**
 * Normalizes query parameter objects by stripping undefined values and sorting keys lexicographically.
 * Ensures consistent TanStack Query cache key matching for structurally identical requests.
 *
 * @param params Query parameters record.
 * @returns Normalized record with sorted keys, or `undefined`.
 */
function normalizeParams<T extends object>(params: T | undefined) {
  if (params === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Merges the scope's Brand Profile selection into a query-param object.
 *
 * `scope.brandProfileId` is the canonical "active profile" selection; `null`
 * means the aggregate "All Brand Profiles" view, so the key is omitted and the
 * API returns workspace-wide data. An explicit `brand_profile_id` in `params`
 * wins over the scope so callers can pin a different profile when needed.
 *
 * @param scope Session scope carrying the active Brand Profile selection.
 * @param params Caller-supplied query params, if any.
 * @returns Params object with `brand_profile_id` applied, or `undefined` when
 *   neither source produced any key.
 */
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

/** Cache identities for reads; assets() is only an invalidation prefix, not a library query. */
export const queryKeys = {
  currentUser: () => ["current-user"] as const,
  analytics: () => ["analytics"] as const,
  installation: () => ["installation"] as const,
  workspaceMembers: () => ["workspace-members"] as const,
  workspaceInvitations: () => ["workspace-invitations"] as const,
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

/**
 * Bridges a TanStack Query `queryFn`/`mutationFn` invocation to the frontend
 * Effect service layer.
 *
 * Resolves `ApiClientService` from the request-scoped layer (which carries the
 * Workspace selection via `WorkspaceService`) and executes the selected
 * operation through `runFrontendEffect`, the approved `Effect.run*` boundary.
 * Authentication rides the ambient same-origin session cookie, so no
 * credential is threaded here. The query's AbortSignal is forwarded so
 * cancellation interrupts the underlying network Effect.
 *
 * @param scope Session scope captured by the calling hook.
 * @param operation Selector invoking one `ApiClientService` method.
 * @param signal AbortSignal provided by TanStack Query for this invocation.
 * @returns Promise resolving to the operation result.
 */
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

/**
 * Returns resource prefixes affected when a Brand Profile is deleted.
 *
 * Deletion hides owned content and cancels scheduled work, so cached Posts,
 * attachments, Channels, outcomes, calendars, Queues, and Analytics must refresh.
 */
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

/**
 * Returns the caches one Post mutation can change. Post list and detail share
 * the `posts` prefix, so one prefix covers both; attaching or detaching media
 * changes Asset status and attachment ownership (`assets`), while scheduling
 * moves independent per-Channel outcomes (`distributions`) and their calendar
 * projection. Analytics must also drop a cohort when a Post is deleted or its
 * published caption/format changes. Refreshing these resources after a write
 * prevents a warm browser cache from retaining the previous composition.
 */
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
  removePostFromQueue: () => [...postResourceInvalidations(), queryKeys.queues()],
  createPost: () => postResourceInvalidations(),
  updatePost: () => postResourceInvalidations(),
  deletePost: () => postResourceInvalidations(),
  schedulePost: () => postResourceInvalidations(),
  disconnectPlatform: (id: string) => [
    queryKeys.platforms(),
    queryKeys.platformPublishingRequirements(id),
    queryKeys.analytics(),
  ],
  confirmOAuthSelection: () => [queryKeys.platforms(), queryKeys.analytics()],
  updateDistribution: () => [
    queryKeys.posts(),
    queryKeys.distributions(),
    queryKeys.calendar(),
    queryKeys.analytics(),
  ],
  retryDistribution: () => [queryKeys.posts(), queryKeys.distributions(), queryKeys.calendar()],
  createBrandProfile: () => [queryKeys.brandProfiles()],
  updateBrandProfile: () => [queryKeys.brandProfiles()],
  deleteBrandProfile: () => [queryKeys.brandProfiles(), ...brandProfileResourceInvalidations()],
  workspaceSettings: () => [
    queryKeys.installation(),
    queryKeys.workspaceMembers(),
    queryKeys.workspaceInvitations(),
    queryKeys.currentUser(),
  ],
} satisfies Record<string, (...args: string[]) => QueryKey[]>;

/**
 * Invalidates resource prefixes; Analytics advances its shared window before
 * dependent reads run, avoiding refetching both old and new cohorts.
 *
 * @param queryClient The active TanStack QueryClient.
 * @param keys Array of query keys to invalidate.
 */
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

/**
 * Shared lifecycle for the idempotent mutation hooks below: acquires the
 * QueryClient and a stable idempotency tracker, runs the API operation with a
 * key fingerprinted on the mutation variables, then clears the tracker once
 * the mutation succeeds.
 *
 * Every idempotent hook repeats this acquire/execute/invalidate/clear
 * sequence; centralizing it leaves each exported hook with only its genuinely
 * varying parts — the API call and the caches it invalidates. Fingerprinting
 * the key on the variables makes TanStack retries of the same payload reuse
 * one idempotency key while an edited payload issues a fresh one.
 *
 * @param scope Session scope forwarded to `runApiQuery`.
 * @param operation API call receiving the resolved idempotency key, which it
 *   must forward as `{ idempotencyKey }` so server-side retries deduplicate.
 * @param invalidate Maps mutation variables to the query keys invalidated
 *   after success. Omit when no cached resource depends on the mutation;
 *   the tracker still clears.
 * @returns TanStack mutation result for the operation's variables and data.
 */
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
      if (invalidate) await invalidateQueryKeys(queryClient, invalidate(variables));
      idempotency.clear();
    },
  });
}

/**
 * TanStack query hook for the authenticated user's profile and active workspace organization.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Query result with UserProfile data.
 */
export function useCurrentUser(scope: SessionScope) {
  return useQuery({
    queryKey: queryKeys.currentUser(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getCurrentUser(), signal),
    enabled: scope.isSignedIn,
  });
}

/**
 * TanStack query hook listing the active Brand Profiles in the workspace.
 * Brand Profiles are workspace-scoped, not profile-scoped, so this query never
 * merges `brand_profile_id`.
 * Reuses successful data for five minutes and retains inactive reads for
 * thirty minutes in the identity/Workspace-scoped browser cache. Profile
 * mutations invalidate it immediately; other members' edits appear on refresh
 * or the next stale read.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Query result containing array of BrandProfile records.
 */
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

/**
 * TanStack mutation hook to create a Brand Profile with idempotency tracking.
 * Invalidates the profile list; owned collections are empty for a new profile.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting CreateBrandProfileInput.
 */
export function useCreateBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreateBrandProfileInput, idempotencyKey) =>
      api.createBrandProfile(input, { idempotencyKey }),
    mutationInvalidations.createBrandProfile,
  );
}

/**
 * TanStack mutation hook to rename or recolor a Brand Profile with idempotency tracking.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ profileId, input }`.
 */
export function useUpdateBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { profileId: string; input: UpdateBrandProfileInput }, idempotencyKey) =>
      api.updateBrandProfile(variables.profileId, variables.input, { idempotencyKey }),
    mutationInvalidations.updateBrandProfile,
  );
}

/**
 * TanStack mutation hook to permanently delete a Brand Profile with idempotency tracking.
 * Deletion removes owned content and locally disconnects the profile's
 * channels, so every profile-owned collection is invalidated alongside the
 * profile list.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting the Brand Profile ID string.
 */
export function useDeleteBrandProfile(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, profileId: string, idempotencyKey) =>
      api.deleteBrandProfile(profileId, { idempotencyKey }),
    mutationInvalidations.deleteBrandProfile,
  );
}

/** Sixty fills complete rows in the three-, four-, and five-column Post grids. */
export const POSTS_PAGE_SIZE = 60;

/**
 * Flattens fetched pages without duplicating a Post if concurrent publication
 * or deletion shifted an offset boundary. The earlier page owns an overlapping
 * identity; refetching refreshes the entire cached page chain.
 */
function selectPostPages(data: InfiniteData<PostListResponse, number>): Post[] {
  const posts = new Map<string, Post>();
  for (const page of data.pages) {
    for (const post of page.posts) {
      if (!posts.has(post.id)) posts.set(post.id, post);
    }
  }
  return [...posts.values()];
}

/** Advances eligibility for scheduled work without issuing network reads before its due instant. */
function useDueWorkClock(hasScheduled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!hasScheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [hasScheduled]);
  return now;
}

/**
 * Reads independent progress details with four-request concurrency. Missing
 * identities are removed from loaded projections; other failures retain their
 * last known data and surface through the collection while the next poll retries.
 * Cancellation still propagates instead of producing a partial successful read.
 */
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

/**
 * Keeps draft revisions and independent outcome/Asset timestamps monotonic when
 * an older progress read races a save or a newer detail read. Equal revisions
 * may still contain newer background work; a later poll reconciles the whole
 * server projection rather than inventing a partially merged Post.
 */
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

/**
 * Refreshes loaded Posts with active work, choosing individual details or one
 * batched page refresh based on request count. When active identities outnumber
 * loaded pages, a single invalidation refreshes the authoritative page chain
 * instead of issuing more detail requests than list requests. Future scheduled
 * work becomes eligible at its due instant; settled rows never trigger polling.
 * Detail results preserve page order, remove missing rows, and surface partial
 * failures. Newer revisions win over delayed reads; publication transitions
 * invalidate Analytics and update loaded calendar projections.
 */
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
        post.distributions.some(
          (distribution) =>
            distribution.status === "scheduled" &&
            distribution.scheduled_at !== null &&
            Date.parse(distribution.scheduled_at) <= now,
        ),
    )
    .map((post) => post.id)
    .sort();
  const progress = useQuery({
    queryKey: ["post-progress", collectionKey],
    queryFn: async ({
      signal,
    }): Promise<{ values: Post[]; missing: Set<string>; error: Error | null }> => {
      if (ids.length > pageCount) {
        // A progress tick must not cancel or replace a user's pending Load more.
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
        // Absence from a filtered/offset page is not proof of deletion.
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

/**
 * Caches explicit 60-Post pages in the workspace's browser QueryClient.
 * Only the first page loads automatically; further reads require fetchNextPage.
 * Filters have independent caches, inactive pages survive route navigation for
 * 30 minutes. Stale reads and mutations refresh pages; active progress uses
 * details when sparse and one batched page refresh when denser than the cache.
 * The workspace/auth provider discards the cache when its identity changes;
 * Post content is not persisted to localStorage or IndexedDB.
 *
 * @param scope Signed-in gate and Workspace/Brand Profile authorization scope.
 * @param params Lifecycle and owning-profile filters; pagination is owned here.
 * @returns Infinite-query controls with deduplicated loaded Posts as data.
 */
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
    gcTime: 30 * 60_000,
    staleTime: 60_000,
    enabled: scope.isSignedIn,
  });
  const progressError = usePostProgress(scope, query.data ?? [], collectionKey);
  return { ...query, error: query.error ?? progressError };
}

/**
 * TanStack query hook hydrating one Post: its ordered attachments, saved
 * per-Channel target settings, and independent outcomes. This is the single
 * read a composer needs to reopen or edit a saved draft.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param id Post identifier.
 * @param enabled Whether the query is active; defaults to true.
 * @returns Query result with the Post entity.
 */
export function usePost(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.post(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getPost(id), signal),
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
  });
}

/**
 * TanStack mutation hook creating one nonempty authoritative draft Post.
 * Repeat saves of the same composition go through `useUpdatePost` on the
 * returned id; the idempotency key makes a retried create of one payload
 * return the same Post rather than a duplicate.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting CreatePostInput.
 */
export function useCreatePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreatePostInput, idempotencyKey) => api.createPost(input, { idempotencyKey }),
    mutationInvalidations.createPost,
  );
}

/**
 * TanStack mutation hook saving the same Post's draft surface — default text,
 * the whole ordered attachment set, and saved per-Channel targets — without
 * requiring any Channel selection.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ id, input }`; the `id` keeps the Post identity stable.
 */
export function useUpdatePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdatePostInput }, idempotencyKey) =>
      api.updatePost(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.updatePost,
  );
}

/**
 * TanStack mutation hook soft-deleting a Post. Pending publications stop and
 * attachment references are released, while already-delivered Channel copies
 * remain immutable history. The owning Brand Profile travels in the variables
 * — never inferred from the active scope — so the aggregate "All Brand
 * Profiles" view can delete a Post it can see and a bulk deletion batch can
 * span profiles without a scope switch. Callers pass the Post's own
 * `brand_profile_id`; the API rejects a Post not owned by that profile.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ id, brandProfileId }`.
 */
export function useDeletePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; brandProfileId: string }, idempotencyKey) =>
      api.deletePost(variables.id, variables.brandProfileId, { idempotencyKey }),
    mutationInvalidations.deletePost,
  );
}

/** One failed deletion in a bulk batch, kept so the caller can retry it. */
interface BulkDeleteFailure {
  id: string;
  message: string;
}

/** Result of one confirmed bulk deletion: successful identities and retryable failures. */
interface BulkDeleteOutcome {
  deletedIds: string[];
  failed: BulkDeleteFailure[];
}

/**
 * Upper bound on concurrent per-Post deletion requests. Four keeps the batch
 * responsive without turning a large selection into one unbounded burst; the
 * backend row lock already serializes any two requests for the same Post.
 */
const BULK_DELETE_CONCURRENCY = 4;

/** One Post deletion addressed by its owning Brand Profile. */
export interface DeletePostTarget {
  id: string;
  brandProfileId: string;
}

/** Extracts a retry-facing message from a typed failure, defect, or interruption. */
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

/**
 * Deletes a batch of Posts with bounded concurrency and per-item isolation.
 *
 * Every request uses the batch idempotency key plus the target position, so a
 * retried batch reuses the same keys. `Effect.exit` captures both typed API
 * failures and transport defects: a rejected request becomes one failed item
 * instead of aborting the batch and discarding deletions that already
 * committed. The caller receives successful identities and retryable failures
 * as data.
 *
 * @param deleteOne Operation issuing one authenticated Post deletion.
 * @param targets Posts to delete, in selection order.
 * @param idempotencyKey Stable key for this batch.
 * @returns Effect resolving to successful ids and per-target failures.
 */
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

/**
 * TanStack mutation hook deleting a batch of Posts with bounded concurrency and
 * one cache invalidation after the batch settles.
 *
 * The per-Post endpoint is unchanged, so each request keeps its own
 * idempotency key derived from the batch key and target position; a retried
 * batch reuses those keys. Failures are returned as data instead of rejecting
 * the mutation so one unavailable Post cannot discard the successes or the
 * caller's retry list.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ targets }` and resolving `BulkDeleteOutcome`.
 */
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

/**
 * TanStack mutation hook scheduling one Post to its target Channels, or
 * publishing immediately when `scheduled_at` is null. Only still-editable
 * pending outcomes change, so a retry of the same intent never duplicates a
 * Distribution or republishes a settled one.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ id, input }`; the `id` keeps the Post identity stable.
 */
export function useSchedulePost(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: SchedulePostInput }, idempotencyKey) =>
      api.schedulePost(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.schedulePost,
  );
}
/** Pages active Queues for one explicit owner. Additional pages are user-driven; disabled consumers perform no reads. */
export function useQueues(scope: SessionScope, brandProfileId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.queues(brandProfileId ?? ""),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      runApiQuery(
        scope,
        (api) =>
          api.listQueues({
            brand_profile_id: brandProfileId!,
            limit: 50,
            ...(pageParam ? { cursor: pageParam } : {}),
          }),
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: scope.isSignedIn && brandProfileId !== null && enabled,
  });
}

/** Pages a Queue's bounded window; sparse progress uses details and dense progress refreshes its loaded pages once. */
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

/** Creates a recurring plan with the shared stable-key mutation lifecycle. */
export function useCreateQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, input: CreateQueueInput, idempotencyKey) => api.createQueue(input, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

/** Edits only future allocations and refreshes the authoritative configuration roster. */
export function useUpdateQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdateQueueInput }, idempotencyKey) =>
      api.updateQueue(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

/** Retires an idle plan, surfacing unresolved membership as a recoverable conflict. */
export function useDeleteQueue(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; brandProfileId: string }, idempotencyKey) =>
      api.deleteQueue(variables.id, variables.brandProfileId, { idempotencyKey }),
    mutationInvalidations.queueConfiguration,
  );
}

/** Releases one safely editable Queue reservation and refreshes Posts, outcomes and timeline together. */
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

/**
 * TanStack query hook reading one Asset by durable identifier with
 * active-state polling, so composer attachment thumbnails and analytics
 * metadata follow upload and processing progress.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param id Asset identifier.
 * @param enabled Whether the query is active; defaults to true.
 * @returns Query result with Asset data.
 */
export function useAsset(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.asset(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getAsset(id), signal),
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
  });
}

/**
 * TanStack query hook for acquiring an asset's presigned media preview URL.
 * Cached with a 10-minute stale time to prevent redundant presigned URL generations.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param id Asset identifier.
 * @param enabled Whether the query is active; defaults to true.
 * @returns Query result with SignedUrlResponse.
 */
export function useAssetPreviewUrl(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.assetPreview(id),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getAssetPreviewUrl(id), signal),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
    staleTime: 10 * 60 * 1_000,
  });
}

/**
 * TanStack query hook for connected platform accounts.
 *
 * Profile filtering changes the query key. Retaining the prior account list
 * while the replacement streams prevents a selected filter from blanking the
 * Channels toolbar and main view; the normal loading skeleton is therefore
 * reserved for the first account fetch.
 * Successful reads remain fresh for five minutes and survive inactive route
 * navigation for thirty minutes; account mutations still invalidate them.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param options `enabled` gates the query; `brandProfileId` overrides the scope selection.
 * @returns Query result containing array of PlatformAccount records.
 */
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

/**
 * TanStack query hook for platform capabilities specifications across all providers.
 *
 * Deployment-defined capabilities are static for the lifetime of one
 * identity/Workspace-scoped QueryClient, so this single bounded query alone
 * keeps successful data fresh and retained indefinitely. Mount, focus,
 * reconnect, and time-based refetches therefore reuse the successful result
 * instead of calling the API again; replacing the scoped client (sign-out or
 * identity/Workspace switch) starts empty and loads fresh. Results stay in
 * browser memory only, and account mutations intentionally do not invalidate
 * them. General query defaults and dynamic publishing-requirement freshness
 * remain unchanged.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Query result containing array of PlatformCapability records.
 */
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

/**
 * TanStack query hook for dynamic publishing requirements and TikTok privacy settings.
 * Cached with 60-second stale time.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param id Platform account ID.
 * @param enabled Whether the query is active; defaults to true.
 * @returns Query result with PublishingRequirements.
 */
export function usePlatformPublishingRequirements(scope: SessionScope, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.platformPublishingRequirements(id),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.getPlatformPublishingRequirements(id), signal),
    enabled: scope.isSignedIn && id.length > 0 && enabled,
    staleTime: 60 * 1_000,
  });
}

/**
 * TanStack mutation hook to disconnect a platform account and invalidate relevant caches.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting platform account ID.
 */
export function useDisconnectPlatform(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.disconnectPlatform(id, { idempotencyKey }),
    mutationInvalidations.disconnectPlatform,
  );
}

/**
 * TanStack mutation hook that initiates the OAuth handshake for a social platform.
 * Resolves to the provider authorization URL the caller redirects to. The
 * `brandProfileId` is pinned into durable OAuth state so the connected channel
 * is owned by that Brand Profile.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ platform }`.
 */
export function useStartPlatformOAuth(scope: SessionScope) {
  return useMutation({
    mutationFn: (variables: { platform: Platform }) =>
      runApiQuery(scope, (api) => api.startPlatformOAuth(variables.platform)),
  });
}

/**
 * TanStack query hook for inspecting candidate external accounts for an OAuth selection ticket.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param selectionId Opaque routing selection nonce.
 * @param enabled Whether the query is active; defaults to true.
 * @returns Query result containing candidate accounts and selection ticket metadata.
 */
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

/**
 * TanStack idempotent mutation confirming a candidate account selection.
 * Invalidates platform account caches upon successful connection.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ selectionId, input: { account_id } }`.
 */
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

/**
 * TanStack idempotent mutation cancelling and discarding an active OAuth selection ticket.
 * Cancellation discards the ticket without saving or invalidating platform connections.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `selectionId`.
 */
export function useCancelOAuthSelection(scope: SessionScope) {
  return useIdempotentMutation(scope, (api, selectionId: string, idempotencyKey) =>
    api.cancelOAuthSelection(selectionId, { idempotencyKey }),
  );
}

/**
 * TanStack mutation hook to retry a failed distribution with idempotency tracking.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting distribution ID string.
 */
export function useRetryDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.retryDistribution(id, { idempotencyKey }),
    mutationInvalidations.retryDistribution,
  );
}

/**
 * TanStack mutation hook to reschedule or modify text overrides for a pending distribution.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting `{ id, input }`.
 */
export function useUpdateScheduledDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, variables: { id: string; input: UpdateDistributionInput }, idempotencyKey) =>
      api.updateScheduledDistribution(variables.id, variables.input, { idempotencyKey }),
    mutationInvalidations.updateDistribution,
  );
}

/**
 * TanStack mutation hook to cancel a scheduled or queued distribution.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @returns Mutation hook accepting distribution ID string.
 */
export function useCancelDistribution(scope: SessionScope) {
  return useIdempotentMutation(
    scope,
    (api, id: string, idempotencyKey) => api.cancelDistribution(id, { idempotencyKey }),
    mutationInvalidations.updateDistribution,
  );
}

/**
 * Tracks active or due Distribution identities in a loaded Calendar range.
 * A single active outcome uses a detail read; multiple active outcomes refresh
 * the bounded range once rather than fan out one detail request per event.
 * Sparse detail results preserve range membership and settled rows; newer
 * timestamps win over delayed reads. Publication invalidates Analytics once.
 */
function useCalendarProgress(
  scope: SessionScope,
  events: readonly CalendarEvent[],
  collectionKey: QueryKey,
) {
  const queryClient = useQueryClient();
  const now = useDueWorkClock(events.some((event) => event.status === "scheduled"));
  const ids = events
    .filter(
      (event) =>
        pollingInterval(event) !== false ||
        (event.status === "scheduled" &&
          event.scheduled_at !== null &&
          Date.parse(event.scheduled_at) <= now),
    )
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

/**
 * TanStack query hook for Calendar events within a specified date window.
 * One active event uses a Distribution detail read; multiple active events
 * trigger one batched range refresh. Settled events never cause periodic reads.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace;
 *   its active Brand Profile is merged into params as `brand_profile_id`.
 * @param params Date range parameters ({ start, end }).
 * @returns Query result containing array of CalendarEvent objects.
 */
export function useCalendar(scope: SessionScope, params?: CalendarQueryParams) {
  const scopedParams = params ? withBrandProfile(scope, params) : undefined;
  const collectionKey = queryKeys.calendar(scopedParams);
  const query = useQuery({
    queryKey: collectionKey,
    queryFn: ({ signal }) => {
      if (!scopedParams) return Promise.resolve([]);
      return runApiQuery(
        scope,
        (api) => Effect.map(api.getCalendar(scopedParams), (res) => res.events),
        signal,
      );
    },
    enabled: scope.isSignedIn && Boolean(scopedParams),
  });
  const progressError = useCalendarProgress(scope, query.data ?? [], collectionKey);
  return { ...query, error: query.error ?? progressError };
}

/**
 * Reads installation Seat usage and the shared Workspace metadata.
 *
 * @param scope Session scope gating execution.
 * @param workspaceId Shared Workspace UUID from the current profile.
 * @param enabled Whether the query may run.
 * @returns Query result with installation settings.
 */
export function useInstallation(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.installation(),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.getInstallation(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

/**
 * Shares one exact rolling cohort across dashboard and ranked reads in the
 * current browser QueryClient. All mounted Analytics consumers observe this
 * snapshot, so changing a metric cannot silently advance only half the page.
 * Five-minute freshness controls navigation/focus reuse. Invalidation advances
 * every read together; a generation also distinguishes refreshes under a
 * frozen or coarse clock. Exact API instants are never rounded.
 */
function useAnalyticsWindow(scope: SessionScope, range: AnalyticsRangePreset) {
  return useQuery({
    queryKey: ["analytics", "window", range],
    queryFn: () => ({ ...analyticsRangeWindow(range), generation: crypto.randomUUID() }),
    staleTime: referenceFreshnessMs,
    gcTime: privateCacheRetentionMs,
    enabled: scope.isSignedIn,
  });
}

/**
 * Reads the dashboard's daily series, best-time cells, format and platform
 * breakdowns, follower history, and engagement accumulation for one cohort.
 * Successful reads stay fresh for five minutes in browser memory; ranked
 * reads share the same exact window and explicit Refresh advances both.
 *
 * @param scope Session scope: signed-in gate, Workspace, and Brand Profile.
 * @param params Range preset plus optional Platform, account, and format filters.
 * @returns TanStack query carrying the dashboard aggregates.
 */
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

/**
 * Loads the inspected Post's stored histories with at most four simultaneous
 * requests. The Post prefix shares mutation invalidation; Workspace and sorted
 * Distribution identities prevent data leaking between inspectors or tenants.
 * Any failed Channel rejects the whole read rather than presenting partial totals.
 */
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

/**
 * Lists Workspace members with role, status, and join date.
 *
 * @param scope Session scope gating execution.
 * @param workspaceId Shared Workspace UUID.
 * @param enabled Whether the query may run.
 * @returns Query result with the member list.
 */
export function useWorkspaceMembers(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceMembers(),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.listWorkspaceMembers(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

/**
 * Reads the ranked per-Post analytics rows for the same cohort.
 *
 * Limit, metric, and offset participate in the cache key; dashboard and ranked
 * reads reuse one exact five-minute browser cohort. Keeping previous data
 * avoids collapsing the table while Load more or a metric switch fetches.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId`
 *   selects the Workspace, and `brandProfileId` selects the profile scope.
 * @param params Range preset, optional Platform filter, ranking metric, and
 *   the requested top-N window.
 * @returns Query result with the ranked Posts and pagination metadata.
 */
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

/**
 * Lists pending Workspace invitations.
 *
 * @param scope Session scope gating execution.
 * @param workspaceId Shared Workspace UUID.
 * @param enabled Whether the query may run.
 * @returns Query result with pending invitations.
 */
export function useWorkspaceInvitations(scope: SessionScope, workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceInvitations(),
    queryFn: ({ signal }) =>
      runApiQuery(scope, (api) => api.listWorkspaceInvitations(workspaceId), signal),
    enabled: scope.isSignedIn && enabled,
  });
}

/**
 * Reads the reverse-chronological Workspace Audit trail.
 *
 * @param scope Session scope gating execution.
 * @param workspaceId Shared Workspace UUID.
 * @param params Pagination window.
 * @param enabled Whether the query may run.
 * @returns Query result with audit entries.
 */
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

/**
 * Invites an address with an assignable Workspace role.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, email, role }`.
 */
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

/**
 * Rotates and resends an invitation.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, invitationId }`.
 */
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

/**
 * Revokes a pending invitation and frees its Seat.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, invitationId }`.
 */
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

/**
 * Changes a member's Workspace role.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, memberId, role }`.
 */
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

/**
 * Removes a member's Workspace membership.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, memberId }`.
 */
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

/**
 * Suspends a member account.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, memberId, reason }`.
 */
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

/**
 * Reactivates a suspended member.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, memberId }`.
 */
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

/**
 * Hard-deletes a member account after email confirmation.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, memberId, confirmEmail }`.
 */
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

/**
 * Transfers installation ownership after password reauthentication.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, targetUserId, password }`.
 */
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

/**
 * Renames the shared Workspace.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting `{ workspaceId, name }`.
 */
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

/**
 * Accepts an invitation for the authenticated account. The server verifies
 * that the token is pending and bound to the caller's email, then returns the
 * joined Workspace and member.
 *
 * @param scope Session scope gating execution.
 * @returns Mutation accepting the invitation token.
 */
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

/**
 * Inspects an invitation token before the visitor has an account.
 *
 * @param token Raw invitation token, or null while absent.
 * @returns Query result with the invitation preview.
 */
export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: ({ signal }) =>
      runFrontendEffect(
        { brandProfileId: null, isSignedIn: false, workspaceId: null },
        Effect.flatMap(ApiClientService, (api) => api.getInvitationPreview(token ?? "")),
        { signal },
      ),
    enabled: token !== null && token.length >= 16,
  });
}
