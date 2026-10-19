import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ChannelIntegration, UserProfile } from "@/api/types";
import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useBrandProfiles, useCurrentUser, usePlatforms } from "@/lib/queries";
import type { BrandProfile, PlatformAccount, UserProfile as ContractUserProfile } from "@/types";
export interface ChannelStatusInfo {
  integration: ChannelIntegration;
  isAvailable: boolean;
  reason?: string;
}

export interface WorkspaceContextValue {
  user: UserProfile | null;
  /** Active Brand Profiles in the workspace, ordered by name (real API data). */
  brandProfiles: BrandProfile[];
  integrations: ChannelIntegration[];
  /**
   * Active Brand Profile selection; `null` is the aggregate "All Brand
   * Profiles" view, which is read-only for profile-owned mutations.
   */
  selectedBrandProfileId: string | null;
  /** Resolved active Brand Profile entity, or `null` in the aggregate view. */
  selectedBrandProfile: BrandProfile | null;
  /** Display name of the active workspace organization. */
  workspaceName: string | null;
  /** True when the signed-in user holds the workspace `admin` role. */
  isAdmin: boolean;
  selectedChannelIds: string[];
  channelStatuses: ChannelStatusInfo[];
  isLoading: boolean;
  error: string | null;
  /** Selects the active Brand Profile; `null` returns to the aggregate view. */
  setSelectedBrandProfileId: (id: string | null) => void;
  toggleChannelSelection: (channelId: string) => void;
  /**
   * Replaces the selected destination set. `null` restores the eligible-default
   * selection a fresh workspace starts from; `[]` stays an intentional empty
   * selection the creator asked for, so the two are never collapsed.
   */
  setSelectedChannelIds: (ids: string[] | null) => void;
  refreshWorkspace: () => Promise<void>;
  logout: () => Promise<void>;
  /** Selected platform filter across the workspace (`[]` means all platforms). */
  selectedPlatforms: string[];
  /** Updates the active platform filter across the workspace. */
  setSelectedPlatforms: (platforms: string[] | ((prev: string[]) => string[])) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Maps the contract identity into the frontend's display shape (`name`, `orgId`).
 * Carries the API's account avatar through unchanged; the view owns image-loading
 * fallback, without deriving external image requests from the user's email.
 *
 * @param profile Contract user profile returned by `GET /users/me`.
 * @returns Source-shaped user profile for workspace consumers.
 */
function toSourceUser(profile: ContractUserProfile): UserProfile {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.display_name ?? profile.email,
    avatarUrl: profile.avatar_url,
    orgId: profile.active_organization.id,
    role: profile.active_organization.role,
  };
}

/**
 * Maps a contract `PlatformAccount` into the source `ChannelIntegration` shape.
 * `connection_status` drives the source's availability flags: `revoked` reads as
 * disabled, `expired`/`reconnect_required` read as needing re-authentication, and
 * `expiring` stays available while still surfacing through `channelStatuses`.
 * `brand_profile_id` carries the owning Brand Profile so views can filter and
 * label channels by profile; `platform_user_id` preserves the provider's channel
 * identifier for identity rows, separately from Meltiply's internal account id.
 * `username` remains the real optional handle; never infer it from either id or
 * the display name, which can independently contain an @-prefixed label.
 *
 * @param account Contract platform account from `GET /platforms`.
 * @returns Source-shaped channel integration for workspace consumers.
 */
function toSourceIntegration(account: PlatformAccount): ChannelIntegration {
  const refreshNeeded =
    account.connection_status === "expired" || account.connection_status === "reconnect_required";
  return {
    id: account.id,
    platformUserId: account.platform_user_id,
    username: account.username,
    name: account.display_name ?? account.platform_user_id,
    picture: account.avatar_url,
    providerIdentifier: account.platform,
    type: account.platform,
    disabled: account.connection_status === "revoked",
    refreshNeeded,
    brandProfileId: account.brand_profile_id,
  };
}

/**
 * Top-level context provider managing workspace domain state, the active Brand
 * Profile selection, connected channel integrations, and channel selection for
 * the source-derived shell.
 *
 * Backed by real Meltiply data: the Better Auth session supplies user identity
 * and the selected workspace (`useSessionScope`), while `useCurrentUser`,
 * `useBrandProfiles`, and `usePlatforms` issue `/api/v1` requests authorized by
 * the in-memory bearer JWT — the session cookie is only sent to the
 * `/api/auth/*` lifecycle endpoints that mint it. The platform list is always
 * fetched aggregate (`brandProfileId: null`) so posts and inbox views can
 * resolve owning profiles across every channel; per-view filtering happens at
 * the consumers.
 * Account avatars come from `/users/me`, or the auth session image while that
 * query loads, so provider-supplied pictures survive the workspace projection.
 * Eligible channels are selected until the first explicit edit. That edit starts
 * from the visible defaults; an explicit empty selection stays empty on refresh.
 *
 * @param props.children - Subtree requiring workspace state.
 * @param props.initialUser - Optional test seam overriding the resolved user.
 */
export function WorkspaceProvider({
  children,
  initialUser,
}: {
  children: ReactNode;
  initialUser?: UserProfile | null;
}) {
  const {
    isLoaded,
    isSignedIn,
    user: authUser,
    brandProfileId: selectedBrandProfileId,
    setBrandProfileId,
    signOut,
  } = useMeltiplyAuth();
  const scope = useSessionScope();
  const { workspaceId } = scope;
  const queryClient = useQueryClient();

  const userQuery = useCurrentUser(scope);
  const brandProfilesQuery = useBrandProfiles(scope);
  const platformsQuery = usePlatforms(scope, { brandProfileId: null });

  // null means untouched defaults; [] is an intentional empty selection.
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[] | null>(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const user = useMemo<UserProfile | null>(() => {
    if (initialUser !== undefined) return initialUser;
    if (!isSignedIn) return null;
    if (userQuery.data) return toSourceUser(userQuery.data);
    if (authUser) {
      return {
        id: authUser.id,
        email: authUser.email,
        name: authUser.name ?? authUser.email,
        avatarUrl: authUser.image,
        orgId: workspaceId ?? "",
      };
    }
    return null;
  }, [initialUser, isSignedIn, userQuery.data, authUser, workspaceId]);

  const brandProfiles = useMemo<BrandProfile[]>(
    () => brandProfilesQuery.data ?? [],
    [brandProfilesQuery.data],
  );

  const integrations = useMemo<ChannelIntegration[]>(
    () => (platformsQuery.data ?? []).map(toSourceIntegration),
    [platformsQuery.data],
  );

  const selectedBrandProfile = useMemo(
    () => brandProfiles.find((profile) => profile.id === selectedBrandProfileId) ?? null,
    [brandProfiles, selectedBrandProfileId],
  );

  // A selected profile can disappear (deleted by an admin, or removed from the
  // workspace). Once the profile list resolves, drop a stale selection back to
  // the aggregate view so no request carries a dead `brand_profile_id`.
  useEffect(() => {
    if (selectedBrandProfileId === null || brandProfilesQuery.data === undefined) return;
    if (!brandProfilesQuery.data.some((profile) => profile.id === selectedBrandProfileId)) {
      setBrandProfileId(null);
    }
  }, [brandProfilesQuery.data, selectedBrandProfileId, setBrandProfileId]);

  const workspaceName = userQuery.data?.active_organization.name ?? null;
  const isAdmin = user?.role === "admin";

  const defaultSelectedChannelIds = useMemo(
    () => integrations.filter((ch) => !ch.disabled && !ch.refreshNeeded).map((ch) => ch.id),
    [integrations],
  );
  const effectiveSelectedChannelIds = selectedChannelIds ?? defaultSelectedChannelIds;

  const channelStatuses = useMemo<ChannelStatusInfo[]>(
    () =>
      integrations.map((ch) => {
        if (ch.disabled) {
          return { integration: ch, isAvailable: false, reason: "Channel is currently disabled" };
        }
        if (ch.refreshNeeded) {
          return {
            integration: ch,
            isAvailable: false,
            reason: "Authentication expired — reconnection required",
          };
        }
        return { integration: ch, isAvailable: true };
      }),
    [integrations],
  );

  /**
   * Toggles the selection the creator actually sees. The first interaction
   * materializes eligible defaults; later toggles preserve explicit empty state.
   */
  const toggleChannelSelection = useCallback(
    (channelId: string) => {
      setSelectedChannelIds((previous) => {
        const selected = previous ?? defaultSelectedChannelIds;
        return selected.includes(channelId)
          ? selected.filter((id) => id !== channelId)
          : [...selected, channelId];
      });
    },
    [defaultSelectedChannelIds],
  );

  const refreshWorkspace = useCallback(async () => {
    await queryClient.invalidateQueries();
  }, [queryClient]);

  const isLoading =
    !isLoaded || (isSignedIn === true && (userQuery.isPending || brandProfilesQuery.isPending));
  const error =
    userQuery.error instanceof Error
      ? userQuery.error.message
      : brandProfilesQuery.error instanceof Error
        ? brandProfilesQuery.error.message
        : platformsQuery.error instanceof Error
          ? platformsQuery.error.message
          : null;

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      user,
      brandProfiles,
      integrations,
      selectedBrandProfileId,
      selectedBrandProfile,
      workspaceName,
      isAdmin,
      selectedChannelIds: effectiveSelectedChannelIds,
      channelStatuses,
      isLoading,
      error,
      setSelectedBrandProfileId: setBrandProfileId,
      toggleChannelSelection,
      setSelectedChannelIds,
      refreshWorkspace,
      logout: signOut,
      selectedPlatforms,
      setSelectedPlatforms,
    }),
    [
      user,
      brandProfiles,
      integrations,
      selectedBrandProfileId,
      selectedBrandProfile,
      workspaceName,
      isAdmin,
      effectiveSelectedChannelIds,
      channelStatuses,
      isLoading,
      error,
      setBrandProfileId,
      toggleChannelSelection,
      refreshWorkspace,
      signOut,
      selectedPlatforms,
      setSelectedPlatforms,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/**
 * Hook to consume the active workspace context in components.
 * Provides user, Brand Profiles, integrations, channel selection, and mutation actions.
 * Throws an error if invoked outside of `WorkspaceProvider`.
 *
 * @returns The active WorkspaceContextValue.
 */
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
