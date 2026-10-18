import { useState, useMemo, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { PLATFORM_IDS } from "@meltiply/domain";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  usePlatforms,
  usePlatformCapabilities,
  useDisconnectPlatform,
  useStartPlatformOAuth,
} from "@/lib/queries";
import { useSearchParams } from "@/lib/navigation";
import { CONNECTION_TONES, oauthOutcomeMessage, platformDisplayName } from "@/lib/platforms";
import { useI18n } from "@/lib/i18n";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import {
  brandProfileColorClass,
  type BrandProfile,
  type ConnectionStatus,
  type Platform,
  type PlatformAccount,
} from "@/types";
import { Empty, EmptyIcon, EmptyTitle, EmptyDescription } from "@meltiply/ui/empty";
import { RollingCount } from "@meltiply/ui/rolling-count";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@meltiply/ui/tabs";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { BrandProfileDirectory } from "@/components/workspace/brand-profile-directory";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Alert } from "@meltiply/ui/alert";
import { toast } from "@meltiply/ui/toast";
import { useLatchedValue } from "@meltiply/ui/use-latched-value";
import {
  CenterAlertDialog,
  CenterAlertDialogAction,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogDescription,
  CenterDialogHeader,
  CenterDialogTitle,
} from "@meltiply/ui/center-dialog";
import {
  BrandProfileSelect,
  brandProfileFilterLabel,
} from "@/components/workspace/brand-profile-select";
import { StatusPill } from "@meltiply/ui/status-pill";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { BrandProfileDialog } from "@/components/workspace/brand-profile-dialog";
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
import { BulkSelectionBar } from "@/components/layout/bulk-selection-bar";
import { ChannelTableView, type ChannelTableEntry } from "./channel-table-view";
import { FacebookPageSelectionDialog } from "./facebook-page-selection-dialog";
import {
  PlatformFilterSelect,
  platformFilterLabel,
} from "@/components/workspace/platform-filter-select";
import {
  TopToolbar,
  TopToolbarSearch,
  TopToolbarReset,
  TopToolbarButton,
  TopToolbarFilters,
  TopToolbarFilterChips,
  TopToolbarFilterChip,
} from "@/components/layout/top-toolbar";
import { AlertCircle, Check, Plus, Search, Share2, Unplug, UserPlus } from "lucide-react";
import { cn } from "@meltiply/ui/utils";

/**
 * Metadata definition for a supported external social or publishing platform.
 */
interface PlatformMeta {
  /** Unique platform slug identifier (e.g., 'x', 'linkedin', 'instagram'). */
  id: string;
  /** Human-readable display label of the platform. */
  name: string;
  /** Broad category classification of the publishing destination. */
  category: "social" | "video";
  /** Brief description of supported post formats and features on this platform. */
  description: string;
  /** Optional flag indicating whether the platform is currently linked. */
  connected?: boolean;
}

/**
 * Catalog of connectable social media and video sharing Platforms, keyed by the
 * canonical `PLATFORM_IDS` roster from `@meltiply/domain`. Only Platforms with a
 * live Provider appear here, so every row in the add-channel directory can start
 * a real OAuth flow.
 */
const SUPPORTED_PLATFORMS: PlatformMeta[] = [
  {
    id: "instagram",
    name: "Instagram",
    category: "social",
    description: "Feed posts, Reels, and carousel carousels",
  },
  {
    id: "facebook",
    name: "Facebook",
    category: "social",
    description: "Facebook Pages and community groups",
  },
  {
    id: "youtube",
    name: "YouTube",
    category: "video",
    description: "Long-form videos and YouTube Shorts",
  },
  {
    id: "tiktok",
    name: "TikTok",
    category: "video",
    description: "Short-form videos with custom sound and caption settings",
  },
  {
    id: "threads",
    name: "Threads",
    category: "social",
    description: "Text threads, single photos, and link posts",
  },
];

/**
 * Connection-status filter options for the accounts table, derived directly
 * from the contract-keyed `CONNECTION_TONES` record so the option list can
 * never drift from the `ConnectionStatus` union. Labels render through
 * `tStatus` so they share the status translation catalog.
 */
const CONNECTION_STATUS_OPTIONS = Object.keys(CONNECTION_TONES) as ConnectionStatus[];
const CONNECTION_FILTER_OPTIONS: readonly ("all" | ConnectionStatus)[] = [
  "all",
  ...CONNECTION_STATUS_OPTIONS,
];

/** Toolbar status filter value: the aggregate sentinel or one contract status. */
type StatusFilter = "all" | ConnectionStatus;

/**
 * Props for configuring the ChannelsView management screen.
 */
export interface ChannelsViewProps {
  /**
   * Initial active tab to display. Defaults to checking the URL query parameter
   * (`?tab=all` or `?tab=add`), otherwise defaulting to `'connected'`.
   */
  initialTab?: "connected" | "all";
}

/**
 * Type guard narrowing a directory slug to the contract `Platform` enum, used
 * to gate the OAuth flow and to type the capability lookup.
 *
 * @param id - Platform slug from `SUPPORTED_PLATFORMS`.
 * @returns Whether `id` is a contract-supported Platform.
 */
function isContractPlatform(id: string): id is Platform {
  return (PLATFORM_IDS as readonly string[]).includes(id);
}

/**
 * Manages channel discovery, explicit OAuth account selection, profile
 * directories, and confirmed disconnects. Shared toolbar/dialog primitives
 * preserve filters across OAuth returns; table rows retain profile ownership.
 * `?tab=add|all` opens the connector. Facebook callback tickets open a chooser
 * without saving a Page. Profile edits never open the connector.
 */
export function ChannelsView({ initialTab }: ChannelsViewProps = {}) {
  const {
    integrations,
    channelStatuses,
    brandProfiles,
    selectedBrandProfile,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    selectedPlatforms,
    setSelectedPlatforms,
    isAdmin,
  } = useWorkspace();
  const scope = useSessionScope();
  const { t, tStatus, language } = useI18n();
  const accountsScrollRef = useRef<HTMLDivElement | null>(null);
  const profilesScrollRef = useRef<HTMLDivElement | null>(null);
  useSmoothScrollContainer(accountsScrollRef);
  useSmoothScrollContainer(profilesScrollRef);

  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = useSearchParams();
  const oauthOutcome = searchParams.get("oauth");
  const providerParam = searchParams.get("provider");
  const selectionIdParam = searchParams.get("selection_id");

  const isPageSelectionOpen =
    oauthOutcome === "select_account" && providerParam === "facebook" && Boolean(selectionIdParam);

  const oauthMessage =
    oauthOutcome === "select_account"
      ? null
      : oauthOutcomeMessage(oauthOutcome, providerParam, language);

  const removeOAuthSelectionParams = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("oauth");
    nextParams.delete("provider");
    nextParams.delete("selection_id");
    const searchString = nextParams.toString();
    const nextUrl = searchString ? `${location.pathname}?${searchString}` : location.pathname;
    navigate(nextUrl, { replace: true });
  }, [searchParams, location.pathname, navigate]);

  /** Announces success with the saved Page's name only after the selection API confirms the chosen Page was stored. */
  const handlePageSelectionSuccess = useCallback(
    (pageName: string | null) => {
      toast(t("Facebook connected successfully."), {
        description: pageName ?? t("The selected Page is ready to publish to."),
        variant: "success",
      });
    },
    [t],
  );

  /** Clears the callback ticket after confirmed save or server-side cancellation. */
  const handlePageSelectionOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        removeOAuthSelectionParams();
      }
    },
    [removeOAuthSelectionParams],
  );
  const platformsQuery = usePlatforms(scope);
  const capabilitiesQuery = usePlatformCapabilities(scope);
  const disconnectMutation = useDisconnectPlatform(scope);
  const oauthMutation = useStartPlatformOAuth(scope);
  const tabParam = searchParams.get("tab");
  const shouldOpenAdd = initialTab === "all" || tabParam === "all" || tabParam === "add";

  const [addAccountOpen, setAddAccountOpen] = useState(shouldOpenAdd);
  const [prevShouldOpenAdd, setPrevShouldOpenAdd] = useState(shouldOpenAdd);
  const [selectedConnectProfileId, setSelectedConnectProfileId] = useState<string>("");

  if (shouldOpenAdd !== prevShouldOpenAdd) {
    setPrevShouldOpenAdd(shouldOpenAdd);
    if (shouldOpenAdd) {
      setAddAccountOpen(true);
    }
  }

  const activeConnectProfileId = useMemo(() => {
    if (selectedConnectProfileId && brandProfiles.some((p) => p.id === selectedConnectProfileId)) {
      return selectedConnectProfileId;
    }
    if (selectedBrandProfileId && brandProfiles.some((p) => p.id === selectedBrandProfileId)) {
      return selectedBrandProfileId;
    }
    return brandProfiles[0]?.id ?? "";
  }, [brandProfiles, selectedBrandProfileId, selectedConnectProfileId]);
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<Error | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<PlatformAccount | null>(null);
  const [search, setSearch] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<BrandProfile | null>(null);
  const [directoryTab, setDirectoryTab] = useState<"accounts" | "profiles">("accounts");

  /**
   * Bulk disconnect selection bound to the current mutation scope
   * (workspace + active Brand Profile filter). The scope key rides along so a
   * render-time reset — the same pattern as `prevShouldOpenAdd` — clears the
   * set the moment the workspace or Brand Profile selection changes, before any
   * consumer can act on stale ids. Selection survives view switches and search/
   * platform/status filter changes inside the same scope.
   */
  const selectionScopeKey = `${scope.workspaceId ?? ""}/${selectedBrandProfileId ?? ""}`;
  const [selection, setSelection] = useState(() => ({
    scope: selectionScopeKey,
    ids: new Set<string>(),
  }));
  const selectedIds = selection.ids;

  /** Selected accounts snapshot latched while the bulk confirmation is open. */
  const [bulkTargets, setBulkTargets] = useState<PlatformAccount[] | null>(null);
  /** True while the confirmed sequential disconnect batch is executing. */
  const [bulkRunning, setBulkRunning] = useState(false);
  /** Last confirmation targets, rendered through each dialog's exit so its title never blanks while closing. */
  const shownDisconnectTarget = useLatchedValue(disconnectTarget);
  const shownBulkTargets = useLatchedValue(bulkTargets);
  if (selection.scope !== selectionScopeKey) {
    setSelection({ scope: selectionScopeKey, ids: new Set<string>() });
    setBulkTargets(null);
    setDisconnectTarget(null);
  }

  /**
   * Drops ids the authoritative platform list no longer returns (disconnected
   * elsewhere, scope data reload). While a bulk batch runs or its confirmation
   * is open, in-flight snapshot ids are exempt so a mid-run refetch triggered
   * by per-mutation invalidation cannot prune failed or pending disconnects.
   */
  if (
    selection.scope === selectionScopeKey &&
    selectedIds.size > 0 &&
    platformsQuery.data !== undefined &&
    !platformsQuery.isFetching
  ) {
    const loadedIds = new Set(platformsQuery.data.map((account) => account.id));
    const inFlight = new Set(bulkTargets?.map((target) => target.id) ?? []);
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (loadedIds.has(id) || inFlight.has(id)) next.add(id);
    }
    if (next.size !== selectedIds.size) setSelection({ ...selection, ids: next });
  }
  const accounts = useMemo(() => platformsQuery.data ?? [], [platformsQuery.data]);
  const profileChannelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of accounts)
      counts.set(account.brand_profile_id, (counts.get(account.brand_profile_id) ?? 0) + 1);
    return counts;
  }, [accounts]);
  const integrationById = useMemo(
    () => new Map(integrations.map((i) => [i.id, i])),
    [integrations],
  );
  const statusById = useMemo(
    () => new Map(channelStatuses.map((s) => [s.integration.id, s])),
    [channelStatuses],
  );
  const capabilityByPlatform = useMemo(
    () => new Map((capabilitiesQuery.data ?? []).map((c) => [c.platform, c])),
    [capabilitiesQuery.data],
  );

  const queryError = platformsQuery.error ?? capabilitiesQuery.error;
  const isLoading = platformsQuery.isLoading;

  const normalizedSearch = search.trim().toLowerCase();
  const filteredPlatforms = normalizedSearch
    ? SUPPORTED_PLATFORMS.filter(
        (p) =>
          p.name.toLowerCase().includes(normalizedSearch) ||
          p.description.toLowerCase().includes(normalizedSearch),
      )
    : SUPPORTED_PLATFORMS;

  /**
   * Brand Profile ids claimed by connected accounts, forwarded to the shared
   * `BrandProfileSelect` as `unresolvedProfileIds`. The component keeps only
   * ids missing from `brandProfiles` and renders them as name-only "Unknown
   * profile" rows, so accounts whose owning profile was deleted or left scope
   * stay selectable instead of silently dropping out of the filter.
   */
  const accountProfileIds = useMemo(
    () => accounts.map((account) => account.brand_profile_id),
    [accounts],
  );

  /**
   * Resolves each connected account's current Brand Profile for row ownership context.
   *
   * Missing profiles deliberately remain unresolved so legacy or deleted-profile accounts
   * can render as "Unknown profile" instead of disappearing from the channel directory.
   */
  const profileById = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile])),
    [brandProfiles],
  );

  /**
   * Filters connected accounts into the flat row collection displayed by the directory.
   *
   * Each account is evaluated independently against platform, profile, status, and keyword
   * constraints. Profile names participate in keyword search, while unmapped ownership is
   * presented as "Unknown profile" so every live connection stays reachable.
   */
  const filteredChannels = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();

    return accounts.filter((account) => {
      if (selectedBrandProfileId !== null && account.brand_profile_id !== selectedBrandProfileId)
        return false;
      if (selectedPlatforms.length > 0 && !selectedPlatforms.includes(account.platform))
        return false;
      if (statusFilter !== "all" && account.connection_status !== statusFilter) return false;
      if (!query) return true;

      const platformName = platformDisplayName(account.platform);
      const integration = integrationById.get(account.id);
      const displayName = integration?.name ?? account.display_name ?? platformName;
      const profileName = profileById.get(account.brand_profile_id)?.name ?? t("Unknown profile");

      return [platformName, displayName, profileName].some((value) =>
        value.toLowerCase().includes(query),
      );
    });
  }, [
    accounts,
    accountQuery,
    integrationById,
    selectedPlatforms,
    profileById,
    selectedBrandProfileId,
    statusFilter,
    t,
  ]);

  /**
   * Projects each filtered account into table presentation state: owning profile,
   * integration display overrides, health annotation, and in-flight OAuth state.
   */
  const channelEntries = useMemo<ChannelTableEntry[]>(
    () =>
      filteredChannels.map((account) => {
        const integration = integrationById.get(account.id);
        return {
          account,
          profile: profileById.get(account.brand_profile_id) ?? null,
          displayName: integration?.name ?? account.display_name,
          picture: integration?.picture ?? account.avatar_url,
          statusReason: statusById.get(account.id)?.reason ?? null,
          isReconnecting: connectingPlatform === account.platform,
        };
      }),
    [filteredChannels, integrationById, profileById, statusById, connectingPlatform],
  );

  /** Visible-row selection derived values: select-all means the filtered set only. */
  const visibleSelectedCount = useMemo(
    () =>
      channelEntries.reduce(
        (count, entry) => count + (selectedIds.has(entry.account.id) ? 1 : 0),
        0,
      ),
    [channelEntries, selectedIds],
  );
  const allVisibleSelected =
    channelEntries.length > 0 && visibleSelectedCount === channelEntries.length;

  /**
   * Toggles every currently visible row at once: a fully-selected visible set
   * deselects all of it, otherwise all visible ids are unioned into the
   * selection. Ids hidden by active filters are never touched either way, so
   * deselect-visible cannot silently discard hidden choices.
   */
  const handleToggleVisibleSelection = useCallback(() => {
    setSelection((prev) => {
      const next = new Set(prev.ids);
      const visibleIds = channelEntries.map((entry) => entry.account.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return { ...prev, ids: next };
    });
  }, [channelEntries]);

  /** Toggles one channel's bulk-selection membership; disabled while a batch runs. */
  const handleToggleSelection = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev.ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, ids: next };
    });
  }, []);

  const totalMatchingAccounts = filteredChannels.length;

  const hasActiveFilter = Boolean(
    accountQuery.trim() ||
    selectedPlatforms.length > 0 ||
    selectedBrandProfileId !== null ||
    statusFilter !== "all",
  );
  const platformFilterText = platformFilterLabel(selectedPlatforms, t);
  const profileFilterLabel = brandProfileFilterLabel(selectedBrandProfileId, brandProfiles, t);
  const statusFilterLabel = statusFilter === "all" ? t("All statuses") : tStatus(statusFilter);
  const activeFilterCount =
    Number(selectedPlatforms.length > 0) +
    Number(selectedBrandProfileId !== null) +
    Number(statusFilter !== "all");

  /**
   * Resets every account-table filter back to its unfiltered default so the
   * filtered-empty row's "Clear filters" action restores the full listing.
   */
  const resetAccountFilters = () => {
    setAccountQuery("");
    setSelectedPlatforms([]);
    setSelectedBrandProfileId(null);
    setStatusFilter("all");
  };

  /**
   * Initiates the OAuth 2.0 authorization redirect flow for a selected social provider.
   *
   * Runs the real `useStartPlatformOAuth` mutation and redirects the browser to
   * the contract `authorization_url`. Non-contract directory slugs are ignored
   * (their connect action is disabled); failures surface through the inline
   * `Alert` rather than redirecting. Every connection is owned by a Brand
   * Profile: new connections use the active selection, while re-authentication
   * reuses the account's existing `brand_profile_id` so the aggregate view can
   * still refresh a broken channel.
   *
   * @param platformId - Unique slug identifier of the target provider (e.g. 'tiktok').
   * @param brandProfileId - Brand Profile UUID that will own the connection.
   */
  const handleConnect = async (platformId: string, brandProfileId: string | null) => {
    if (!isContractPlatform(platformId) || brandProfileId === null) return;
    setConnectingPlatform(platformId);
    setConnectError(null);
    try {
      const result = await oauthMutation.mutateAsync({
        platform: platformId,
        brandProfileId,
      });
      const authorizationUrl = new URL(result.authorization_url);
      if (authorizationUrl.protocol !== "https:") {
        throw new Error("The provider returned an unsafe authorization URL.");
      }
      window.location.assign(authorizationUrl.toString());
    } catch (cause) {
      setConnectError(cause instanceof Error ? cause : new Error("OAuth could not be started."));
      setConnectingPlatform(null);
    }
  };

  /**
   * Confirms the pending disconnect request inside the `CenterAlertDialog`.
   *
   * Calls `useDisconnectPlatform` for the targeted account, closes the dialog,
   * and reports the outcome via toast. Mutation errors are caught here so the
   * dialog always settles; the failed account stays listed for retry.
   */
  const handleConfirmDisconnect = async () => {
    const target = disconnectTarget;
    if (!target) return;
    try {
      await disconnectMutation.mutateAsync(target.id);
      toast(t("Channel disconnected"), {
        description: target.display_name ?? platformDisplayName(target.platform),
        variant: "success",
      });
    } catch {
      toast(t("The platform could not be disconnected"), {
        description: t("We could not complete that request. Try again in a moment."),
        variant: "error",
      });
    } finally {
      setDisconnectTarget(null);
    }
  };

  /**
   * Opens the bulk disconnect confirmation with an exact snapshot of the
   * currently selected accounts, resolved against loaded data so hidden-by-
   * filter selections are included and ids disconnected elsewhere are skipped.
   */
  const openBulkDisconnect = () => {
    const targets = accounts.filter((account) => selectedIds.has(account.id));
    if (targets.length === 0) return;
    setBulkTargets(targets);
  };

  /**
   * Executes the confirmed bulk disconnect sequentially over the snapshot
   * latched when the dialog opened — ids added to the selection afterwards are
   * not disconnectable through this dialog. Each successful mutation removes
   * its id immediately so a mid-run invalidation refetch can prune only the
   * resolved rows; failures stay selected for retry. The dialog stays open
   * (and controls disabled) until every attempt settles, then the toast
   * reports the real success/failure counts.
   */
  const handleConfirmBulkDisconnect = async () => {
    const targets = bulkTargets;
    if (!targets || bulkRunning) return;
    setBulkRunning(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const target of targets) {
        try {
          await disconnectMutation.mutateAsync(target.id);
          succeeded += 1;
          setSelection((prev) => {
            const next = new Set(prev.ids);
            next.delete(target.id);
            return { ...prev, ids: next };
          });
        } catch {
          failed += 1;
        }
      }
    } finally {
      setBulkRunning(false);
      setBulkTargets(null);
    }
    if (failed === 0) {
      toast(
        succeeded === 1
          ? t("Channel disconnected")
          : t("{count} channels disconnected", { count: succeeded }),
        {
          description: targets
            .map((target) => target.display_name?.trim() || platformDisplayName(target.platform))
            .join(", "),
          variant: "success",
        },
      );
    } else if (succeeded === 0) {
      toast(t("Channels could not be disconnected"), {
        description: t("We could not complete that request. Try again in a moment."),
        variant: "error",
      });
    } else {
      toast(
        t("{succeeded} of {total} channels disconnected", {
          succeeded,
          total: targets.length,
        }),
        {
          description: t("{failed} could not be disconnected and remain selected.", {
            failed,
          }),
          variant: "error",
        },
      );
    }
  };

  /**
   * Opens the in-place Brand Profile editor in create or edit mode.
   *
   * An omitted profile starts an empty draft; a supplied profile copies its saved name
   * and color. Keeping both flows in one dialog lets profile-filter edit actions
   * and toolbar-level "Create Brand Profile" share one surface, while the latched
   * `editingProfile` distinguishes them so `onSuccess` can chain only fresh creations
   * into the connect-account flow.
   *
   * @param profile - Existing profile to modify, or `undefined` to create one.
   */
  const openProfileEditor = (profile?: BrandProfile) => {
    setEditingProfile(profile ?? null);
    setProfileEditorOpen(true);
  };

  return (
    <WorkspaceSurface
      title={t("Channels")}
      description={t("{count} connected accounts across {profiles} Brand Profiles.", {
        count: accounts.length,
        profiles: brandProfiles.length,
      })}
      className="mx-auto max-w-300"
      actions={
        <>
          <Button
            onClick={() => setAddAccountOpen(true)}
            disabled={brandProfiles.length === 0}
            aria-describedby={brandProfiles.length === 0 ? "add-account-disabled-note" : undefined}
          >
            <Plus className="size-4" />
            {t("Add account")}
          </Button>
          {isAdmin && (
            <Button variant="outline" onClick={() => openProfileEditor()}>
              <UserPlus className="size-4" />
              {t("Create Brand Profile")}
            </Button>
          )}
        </>
      }
    >
      {oauthMessage && (
        <Alert
          variant={oauthOutcome === "connected" ? "info" : "destructive"}
          role={oauthOutcome === "connected" ? "status" : "alert"}
          aria-live={oauthOutcome === "connected" ? "polite" : "assertive"}
        >
          {oauthMessage}
        </Alert>
      )}
      {(queryError || connectError) && (
        <Alert variant="destructive" className="items-center">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <p className="flex-1">{t("An error has occurred.")}</p>
          {queryError && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void Promise.all([platformsQuery.refetch(), capabilitiesQuery.refetch()]);
              }}
            >
              {t("Try again")}
            </Button>
          )}
        </Alert>
      )}

      <Tabs
        value={directoryTab}
        onValueChange={(value) => {
          if (value === "accounts" || value === "profiles") setDirectoryTab(value);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList
          variant="line"
          aria-label={t("Channel directory sections")}
          className="mx-4 sm:mx-6"
        >
          <TabsTrigger value="accounts">
            {t("Accounts")}
            <span className="rounded-chip bg-hover-2 px-1 text-(length:--font-size-micro) text-ink-3">
              <RollingCount value={accounts.length} />
            </span>
          </TabsTrigger>
          <TabsTrigger value="profiles">
            {t("Brand Profiles")}
            <span className="rounded-chip bg-hover-2 px-1 text-(length:--font-size-micro) text-ink-3">
              <RollingCount value={brandProfiles.length} />
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="mt-0 flex min-h-0 flex-1 flex-col">
          <TopToolbar className="border-0 pb-3 pt-3.5">
            <TopToolbarSearch
              id="account-search"
              ariaLabel={t("Search accounts")}
              placeholder={t("Search accounts…")}
              value={accountQuery}
              onChange={setAccountQuery}
            />
            <TopToolbarFilters
              activeCount={
                Number(selectedPlatforms.length > 0) + Number(selectedBrandProfileId !== null)
              }
              onClearAll={() => {
                setSelectedPlatforms([]);
                setSelectedBrandProfileId(null);
              }}
              fields={[
                {
                  id: "platform",
                  label: t("Platform"),
                  active: selectedPlatforms.length > 0,
                  onClear: () => setSelectedPlatforms([]),
                  control: (
                    <PlatformFilterSelect
                      value={selectedPlatforms}
                      onValueChange={setSelectedPlatforms}
                      trigger={<TopToolbarButton label={platformFilterText} className="w-full" />}
                    />
                  ),
                },
                {
                  id: "profile",
                  label: t("Brand Profile"),
                  active: selectedBrandProfileId !== null,
                  onClear: () => setSelectedBrandProfileId(null),
                  control: (
                    <BrandProfileSelect
                      value={selectedBrandProfileId ?? "all"}
                      onValueChange={(id) => setSelectedBrandProfileId(id === "all" ? null : id)}
                      brandProfiles={brandProfiles}
                      unresolvedProfileIds={accountProfileIds}
                      label={t("Brand Profile")}
                      trigger={<TopToolbarButton label={profileFilterLabel} className="w-full" />}
                    />
                  ),
                },
              ]}
            />
            <SegmentedControl
              options={CONNECTION_FILTER_OPTIONS}
              value={statusFilter}
              onChange={setStatusFilter}
              label={t("Connection status")}
              className="max-w-full overflow-x-auto"
              renderOption={(status) => (status === "all" ? t("All statuses") : tStatus(status))}
            />
            <span className="ml-auto text-xs tabular-nums text-ink-3">
              {t("{count} accounts", { count: totalMatchingAccounts })}
            </span>
          </TopToolbar>
          {activeFilterCount > 0 && (
            <TopToolbarFilterChips inset>
              {selectedPlatforms.length > 0 && (
                <TopToolbarFilterChip
                  label={platformFilterText}
                  onClear={() => setSelectedPlatforms([])}
                />
              )}
              {selectedBrandProfileId !== null && (
                <TopToolbarFilterChip
                  label={profileFilterLabel}
                  onClear={() => setSelectedBrandProfileId(null)}
                />
              )}
              {statusFilter !== "all" && (
                <TopToolbarFilterChip
                  label={statusFilterLabel}
                  onClear={() => setStatusFilter("all")}
                />
              )}
              <TopToolbarReset hasActiveFilters onReset={resetAccountFilters} className="ml-auto" />
            </TopToolbarFilterChips>
          )}
          <div
            ref={accountsScrollRef}
            className={cn(
              "min-h-0 flex-1 overflow-auto px-4 pb-24 sm:px-6",
              selectedIds.size > 0 && "pb-32",
            )}
          >
            {isLoading ? (
              <div className="space-y-2 px-4 pt-3.5 sm:px-6">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-16 rounded-control" />
                ))}
              </div>
            ) : accounts.length === 0 ? (
              <Empty className="min-h-60 gap-3.5 border-0">
                <EmptyIcon>
                  <Share2 className="size-5" />
                </EmptyIcon>
                <EmptyTitle>
                  {selectedBrandProfile
                    ? `${selectedBrandProfile.name} ${t("has no channels yet")}`
                    : t("No channels connected yet")}
                </EmptyTitle>
                <EmptyDescription>
                  {t(
                    "Connect your social accounts to start publishing and scheduling across platforms.",
                  )}
                </EmptyDescription>
                {brandProfiles.length === 0 && (
                  <p id="add-account-disabled-note" className="mt-2 text-xs text-ink-3">
                    {isAdmin
                      ? t("Create a Brand Profile before connecting accounts.")
                      : t("Ask a workspace admin to create a Brand Profile.")}
                  </p>
                )}
              </Empty>
            ) : hasActiveFilter && totalMatchingAccounts === 0 ? (
              <Empty className="min-h-60 gap-3.5 border-0">
                <EmptyDescription>{t("No accounts match the active filters.")}</EmptyDescription>
                <Button variant="link" onClick={resetAccountFilters}>
                  {t("Clear filters")}
                </Button>
              </Empty>
            ) : (
              <ChannelTableView
                channels={channelEntries}
                selectedIds={selectedIds}
                allVisibleSelected={allVisibleSelected}
                onToggleVisibleSelection={handleToggleVisibleSelection}
                onToggleSelection={handleToggleSelection}
                selectionDisabled={bulkRunning}
                onReconnect={(account) =>
                  void handleConnect(account.platform, account.brand_profile_id)
                }
                onDisconnect={setDisconnectTarget}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="profiles"
          ref={profilesScrollRef}
          className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3.5 sm:px-6"
        >
          <BrandProfileDirectory
            profiles={brandProfiles}
            channelCounts={profileChannelCounts}
            onViewChannels={(id) => {
              setSelectedBrandProfileId(id);
              setDirectoryTab("accounts");
            }}
            onEdit={isAdmin ? openProfileEditor : undefined}
          />
        </TabsContent>
      </Tabs>

      {/* In-place Brand Profile editor keeps profile management on the Channels page. */}
      <BrandProfileDialog
        open={profileEditorOpen}
        onOpenChange={(open) => {
          setProfileEditorOpen(open);
          if (!open) setEditingProfile(null);
        }}
        profile={editingProfile}
        onSuccess={(profile) => {
          // `editingProfile` is still latched here (the dialog fires onSuccess before
          // onClose), so only a fresh creation selects the new profile and chains
          // into the connect-account flow; saving an edit leaves the active
          // workspace filter selection untouched.
          if (editingProfile === null) {
            setSelectedBrandProfileId(profile.id);
            setSelectedConnectProfileId(profile.id);
            setAddAccountOpen(true);
          }
        }}
      />

      <FacebookPageSelectionDialog
        open={isPageSelectionOpen}
        onOpenChange={handlePageSelectionOpenChange}
        selectionId={selectionIdParam}
        onSuccess={handlePageSelectionSuccess}
      />

      {/* Connect social account dialog */}
      <CenterDialog open={addAccountOpen} onOpenChange={setAddAccountOpen}>
        <CenterDialogContent className="max-w-xl max-h-[90vh] overflow-y-auto" data-lenis-prevent>
          <CenterDialogHeader>
            <CenterDialogTitle>{t("Connect social account")}</CenterDialogTitle>
            <CenterDialogDescription>
              {t(
                "Connect your social accounts to start publishing and scheduling across platforms.",
              )}
            </CenterDialogDescription>
          </CenterDialogHeader>

          <div className="min-w-0 space-y-4 py-2">
            {/* 1. Brand Profile selection */}
            <div className="space-y-1.5">
              <label htmlFor="connect-brand-profile" className="text-xs font-semibold text-ink">
                {t("Brand Profile")}
              </label>
              <Select value={activeConnectProfileId} onValueChange={setSelectedConnectProfileId}>
                <SelectTrigger
                  id="connect-brand-profile"
                  aria-label={t("Brand Profile")}
                  className="h-10 w-full rounded-control border-line bg-surface text-[13px] shadow-inset-field"
                >
                  <SelectValue placeholder={t("Select a Brand Profile")} />
                </SelectTrigger>
                <SelectContent>
                  {brandProfiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2.5 rounded-full border border-line shrink-0",
                            brandProfileColorClass(p.color),
                          )}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-ink">{p.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 2. Social Channels to Connect */}
            <div className="space-y-3 pt-2 border-t border-line/60">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-ink">{t("Social Channels")}</label>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-3" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("Search platforms…")}
                  className="pl-8 h-9 rounded-control border-line bg-surface text-[13px] shadow-inset-field"
                />
              </div>

              {filteredPlatforms.length === 0 ? (
                <div className="p-8 text-center text-sm text-ink-2">
                  {t("No platforms match “{query}”.", { query: search })}
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 max-h-[48vh] overflow-y-auto overscroll-contain pr-1">
                  {filteredPlatforms.map((platform) => {
                    // The directory is the contract roster, so every row is a
                    // connectable Platform. The guard only narrows `id` to the
                    // contract union for the capability lookup below.
                    const capability = isContractPlatform(platform.id)
                      ? capabilityByPlatform.get(platform.id)
                      : undefined;
                    const platformAccounts = accounts.filter(
                      (account) =>
                        account.platform.toLowerCase() === platform.id.toLowerCase() &&
                        account.brand_profile_id === activeConnectProfileId,
                    );
                    const isAlreadyConnected = platformAccounts.length > 0;
                    const connectUnavailable = capability?.connect_available === false;
                    const isConnecting = connectingPlatform === platform.id;

                    return (
                      <div
                        key={platform.id}
                        className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-3 transition-colors hover:border-line-strong"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <PlatformIcon provider={platform.id} className="size-8 shrink-0" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-ink text-[13.5px]">
                                {platformDisplayName(platform.id)}
                              </span>
                              <span className="rounded-full bg-line/60 px-2 py-0.5 text-[10px] font-mono text-ink-3 uppercase">
                                {platform.category}
                              </span>
                            </div>
                            <p className="text-[12px] text-ink-2 truncate max-w-sm mt-0.5">
                              {platform.description}
                            </p>
                          </div>
                        </div>

                        <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-2">
                          {platformAccounts.map((account) => (
                            <div
                              key={account.id}
                              className="flex max-w-full items-center gap-1.5 text-xs"
                            >
                              {account.connection_status === "connected" ? (
                                <Check
                                  className="size-3.5 shrink-0 text-green"
                                  aria-hidden="true"
                                />
                              ) : (
                                <StatusPill
                                  tone={CONNECTION_TONES[account.connection_status]}
                                  className="shrink-0"
                                >
                                  {tStatus(account.connection_status)}
                                </StatusPill>
                              )}
                              <span
                                className="truncate font-medium text-ink"
                                title={account.display_name ?? account.platform_user_id}
                              >
                                {account.display_name ?? account.platform_user_id}
                              </span>
                              {account.connection_status === "connected" && (
                                <span className="sr-only">{tStatus("connected")}</span>
                              )}
                            </div>
                          ))}
                          {(!isAlreadyConnected || !connectUnavailable) && (
                            <Button
                              size="sm"
                              variant={isAlreadyConnected ? "outline" : "default"}
                              disabled={
                                connectUnavailable || isConnecting || !activeConnectProfileId
                              }
                              onClick={() =>
                                void handleConnect(platform.id, activeConnectProfileId)
                              }
                              className={cn(
                                "rounded-control text-xs font-semibold h-8 px-3.5",
                                isAlreadyConnected
                                  ? "border-line text-ink-2"
                                  : "bg-primary text-primary-foreground shadow-btn hover:bg-primary/90",
                              )}
                            >
                              {connectUnavailable
                                ? t("Unavailable")
                                : isConnecting
                                  ? t("Redirecting…")
                                  : isAlreadyConnected
                                    ? t("Add Another")
                                    : t("Connect")}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </CenterDialogContent>
      </CenterDialog>

      {/* Disconnect confirmation */}
      <CenterAlertDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>
              {t("Disconnect {platform}?", {
                platform: shownDisconnectTarget
                  ? (shownDisconnectTarget.display_name ??
                    platformDisplayName(shownDisconnectTarget.platform))
                  : "",
              })}
            </CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Scheduled and queued posts for this channel will stop publishing. You can reconnect it at any time.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel>{t("Cancel")}</CenterAlertDialogCancel>
            <CenterAlertDialogAction
              onClick={() => void handleConfirmDisconnect()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? t("Disconnecting…") : t("Disconnect")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>

      {/* Bulk disconnect confirmation: holds the snapshot latched by the pill. */}
      <CenterAlertDialog
        open={bulkTargets !== null}
        onOpenChange={(open) => {
          if (!open && !bulkRunning) setBulkTargets(null);
        }}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>
              {t("Disconnect {count} channels?", { count: shownBulkTargets?.length ?? 0 })}
            </CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "Scheduled and queued posts for these channels will stop publishing. You can reconnect them at any time.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel disabled={bulkRunning}>{t("Cancel")}</CenterAlertDialogCancel>
            <CenterAlertDialogAction
              onClick={() => void handleConfirmBulkDisconnect()}
              disabled={bulkRunning}
            >
              {bulkRunning ? t("Disconnecting…") : t("Disconnect")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>

      <BulkSelectionBar
        count={selectedIds.size}
        actionLabel={t("Disconnect")}
        actionIcon={Unplug}
        busyLabel={t("Disconnecting…")}
        busy={bulkRunning}
        onClear={() => setSelection((prev) => ({ ...prev, ids: new Set<string>() }))}
        onAction={openBulkDisconnect}
      />
    </WorkspaceSurface>
  );
}
