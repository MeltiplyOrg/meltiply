import { useQueryClient } from "@tanstack/react-query";
import { can, errorMessage, isWorkspaceRole } from "@meltiply/domain";
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
  brandProfiles: BrandProfile[];
  integrations: ChannelIntegration[];
  selectedBrandProfileId: string | null;
  selectedBrandProfile: BrandProfile | null;
  workspaceName: string | null;
  isAdmin: boolean;
  isInstallationOwner: boolean;
  canManageSettings: boolean;
  canWriteContent: boolean;
  canManageConfiguration: boolean;
  selectedChannelIds: string[];
  channelStatuses: ChannelStatusInfo[];
  isLoading: boolean;
  error: string | null;
  setSelectedBrandProfileId: (id: string | null) => void;
  toggleChannelSelection: (channelId: string) => void;
  setSelectedChannelIds: (ids: string[] | null) => void;
  refreshWorkspace: () => Promise<void>;
  logout: () => Promise<void>;
  selectedPlatforms: string[];
  setSelectedPlatforms: (platforms: string[] | ((prev: string[]) => string[])) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function toSourceUser(profile: ContractUserProfile): UserProfile {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.display_name ?? profile.email,
    avatarUrl: profile.avatar_url,
    orgId: profile.active_organization.id,
    role: profile.active_organization.role,
    isInstallationOwner: profile.is_installation_owner,
  };
}

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

  useEffect(() => {
    if (selectedBrandProfileId === null || brandProfilesQuery.data === undefined) return;
    if (!brandProfilesQuery.data.some((profile) => profile.id === selectedBrandProfileId)) {
      setBrandProfileId(null);
    }
  }, [brandProfilesQuery.data, selectedBrandProfileId, setBrandProfileId]);

  const workspaceName = userQuery.data?.active_organization.name ?? null;
  const role = isWorkspaceRole(user?.role) ? user.role : "viewer";
  const isInstallationOwner = user?.isInstallationOwner === true;
  const isAdmin = role === "admin" || isInstallationOwner;
  const canManageSettings = can(role, isInstallationOwner, "member:read");
  const canWriteContent = can(role, isInstallationOwner, "content:write");
  const canManageConfiguration = can(role, isInstallationOwner, "brand-profile:manage");

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
  const firstError = userQuery.error ?? brandProfilesQuery.error ?? platformsQuery.error;
  const error = firstError instanceof Error ? errorMessage(firstError, "") : null;

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      user,
      brandProfiles,
      integrations,
      selectedBrandProfileId,
      selectedBrandProfile,
      workspaceName,
      isAdmin,
      isInstallationOwner,
      canManageSettings,
      canWriteContent,
      canManageConfiguration,
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
      isInstallationOwner,
      canManageSettings,
      canWriteContent,
      canManageConfiguration,
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

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
