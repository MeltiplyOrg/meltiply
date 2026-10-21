import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Effect, Result } from "effect";

import {
  ApiClientService,
  runFrontendEffect,
  type ApiClientError,
  type ApiClientServiceShape,
  type SessionScope,
  type WorkspaceService,
} from "./effect";
import { useMutationKeyTracker } from "./mutation-idempotency";
import { pollingInterval } from "./query-defaults";
import type {
  AuditQueryParams,
  CalendarQueryParams,
  CreateBrandProfileInput,
  CreatePostInput,
  DistributionQueryParams,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformQueryParams,
  PostQueryParams,
  SchedulePostInput,
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
  brandProfiles: () => ["brand-profiles"] as const,
  deletedBrandProfiles: () => ["brand-profiles", "deleted"] as const,
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
 * Returns list-query prefixes whose data becomes visible again when a Brand Profile restores.
 *
 * Profile deletion and restoration both change the same profile-scoped resources, so callers
 * invalidate these prefixes alongside lifecycle lists to prevent cached empty views.
 */
function brandProfileResourceInvalidations(): QueryKey[] {
  return [
    queryKeys.posts(),
    queryKeys.assets(),
    queryKeys.platforms(),
    queryKeys.distributions(),
    queryKeys.calendar(),
  ];
}

/**
 * Returns the caches one Post mutation can change. Post list and detail share
 * the `posts` prefix, so one prefix covers both; attaching or detaching media
 * changes Asset status and attachment ownership (`assets`), while scheduling
 * moves independent per-Channel outcomes (`distributions`) and their calendar
 * projection. Keeping all four current after every Post mutation means a saved
 * draft, an attachment edit, or a publish never leaves a stale list row, a
 * stale processing status, or a stale calendar entry behind.
 */
function postResourceInvalidations(): QueryKey[] {
  return [queryKeys.posts(), queryKeys.distributions(), queryKeys.calendar(), queryKeys.assets()];
}

export const mutationInvalidations = {
  createPost: () => postResourceInvalidations(),
  updatePost: () => postResourceInvalidations(),
  deletePost: () => postResourceInvalidations(),
  schedulePost: () => postResourceInvalidations(),
  disconnectPlatform: (id: string) => [
    queryKeys.platforms(),
    queryKeys.platformPublishingRequirements(id),
  ],
  confirmOAuthSelection: () => [queryKeys.platforms()],
  updateDistribution: () => [queryKeys.distributions(), queryKeys.calendar()],
  retryDistribution: () => [queryKeys.distributions(), queryKeys.calendar()],
  createBrandProfile: () => [queryKeys.brandProfiles()],
  updateBrandProfile: () => [queryKeys.brandProfiles()],
  deleteBrandProfile: () => [
    queryKeys.brandProfiles(),
    queryKeys.deletedBrandProfiles(),
    ...brandProfileResourceInvalidations(),
  ],
  restoreBrandProfile: () => [
    queryKeys.brandProfiles(),
    queryKeys.deletedBrandProfiles(),
    ...brandProfileResourceInvalidations(),
  ],
  workspaceSettings: () => [
    queryKeys.installation(),
    queryKeys.workspaceMembers(),
    queryKeys.workspaceInvitations(),
    queryKeys.currentUser(),
  ],
} satisfies Record<string, (...args: string[]) => QueryKey[]>;

/**
 * Invalidates a list of TanStack Query keys concurrently.
 *
 * @param queryClient The active TanStack QueryClient.
 * @param keys Array of query keys to invalidate.
 */
export async function invalidateQueryKeys(queryClient: QueryClient, keys: QueryKey[]) {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
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
 * TanStack mutation hook to soft-delete a Brand Profile with idempotency tracking.
 * Deletion cancels scheduled work and locally disconnects the profile's
 * channels, so every profile-owned collection is invalidated alongside the
 * profile lists.
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

/**
 * TanStack query hook listing Posts in stable identity order with automatic
 * active-state polling. The scope's Brand Profile selection is merged into
 * `brand_profile_id`; `null` (All Brand Profiles) returns the read-only
 * workspace aggregate. Polling covers both embedded Attachment Asset states
 * (uploading/processing) and queued Channel outcomes, so the surface follows
 * attachment readiness and publication progress without a manual refetch.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace.
 * @param params Optional filters: lifecycle `status` (draft|active), owning
 *   Brand Profile override, and the limit/offset window.
 * @returns Query result with the Post list response.
 */
export function usePosts(scope: SessionScope, params?: PostQueryParams) {
  const scopedParams = withBrandProfile(scope, params);
  return useQuery({
    queryKey: queryKeys.posts(scopedParams),
    queryFn: ({ signal }) => runApiQuery(scope, (api) => api.listPosts(scopedParams), signal),
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn,
  });
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
export interface BulkDeleteFailure {
  id: string;
  message: string;
}

/** Result of one confirmed bulk deletion: successful identities and retryable failures. */
export interface BulkDeleteOutcome {
  deletedIds: string[];
  failed: BulkDeleteFailure[];
}

/**
 * Upper bound on concurrent per-Post deletion requests. Four keeps the batch
 * responsive without turning a large selection into one unbounded burst; the
 * backend row lock already serializes any two requests for the same Post.
 */
const BULK_DELETE_CONCURRENCY = 4;

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
    (
      api,
      variables: { targets: readonly { id: string; brandProfileId: string }[] },
      idempotencyKey,
    ) =>
      Effect.forEach(
        variables.targets,
        (target, index) =>
          Effect.result(
            api.deletePost(target.id, target.brandProfileId, {
              idempotencyKey: `${idempotencyKey}:${index}`,
            }),
          ),
        { concurrency: BULK_DELETE_CONCURRENCY },
      ).pipe(
        Effect.map((results) => {
          const deletedIds: string[] = [];
          const failed: BulkDeleteFailure[] = [];
          results.forEach((result, index) => {
            const target = variables.targets[index]!;
            if (Result.isSuccess(result)) {
              deletedIds.push(target.id);
            } else {
              failed.push({ id: target.id, message: result.failure.message });
            }
          });
          return { deletedIds, failed };
        }),
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
  });
}

/**
 * TanStack query hook for platform capabilities specifications across all providers.
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
 * @returns Mutation hook accepting `{ platform, brandProfileId }`.
 */
export function useStartPlatformOAuth(scope: SessionScope) {
  return useMutation({
    mutationFn: (variables: { platform: Platform; brandProfileId: string }) =>
      runApiQuery(scope, (api) =>
        api.startPlatformOAuth(variables.platform, variables.brandProfileId),
      ),
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
 * TanStack query hook for calendar events within a specified date window.
 * Polling active when events include in-flight distributions.
 *
 * @param scope Session scope: `isSignedIn` gates execution, `workspaceId` selects the Workspace;
 *   its active Brand Profile is merged into params as `brand_profile_id`.
 * @param params Date range parameters ({ start, end }).
 * @returns Query result containing array of CalendarEvent objects.
 */
export function useCalendar(scope: SessionScope, params?: CalendarQueryParams) {
  const scopedParams = params ? withBrandProfile(scope, params) : undefined;
  return useQuery({
    queryKey: queryKeys.calendar(scopedParams),
    queryFn: ({ signal }) => {
      if (!scopedParams) return Promise.resolve([]);
      return runApiQuery(
        scope,
        (api) => Effect.map(api.getCalendar(scopedParams), (res) => res.events),
        signal,
      );
    },
    refetchInterval: (query) => pollingInterval(query.state.data),
    enabled: scope.isSignedIn && Boolean(scopedParams),
  });
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
