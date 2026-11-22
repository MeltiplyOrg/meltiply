import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { PLATFORM_IDS } from "@meltiply/domain";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  usePlatforms,
  usePlatformCapabilities,
  useDisconnectPlatform,
  useStartPlatformOAuth,
} from "@/lib/queries";
import { usePathname, useSearchParams } from "@/lib/navigation";
import { CONNECTION_STATUSES, oauthOutcomeMessage, platformDisplayName } from "@/lib/platforms";
import { Trans, useI18n } from "@/lib/i18n";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import {
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
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { BrandProfileDialog } from "@/components/workspace/brand-profile-dialog";
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
import { BulkSelectionBar } from "@/components/layout/bulk-selection-bar";
import { ChannelTableView, type ChannelTableEntry } from "./channel-table-view";
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

interface PlatformPresentation {
  category: "social" | "video";
  description: string;
}

const PLATFORM_PRESENTATION: Record<Platform, PlatformPresentation> = {
  instagram: {
    category: "social",
    description: "Feed posts, Reels, and carousels",
  },
  facebook: {
    category: "social",
    description: "Facebook Pages and community groups",
  },
  youtube: {
    category: "video",
    description: "Long-form videos and YouTube Shorts",
  },
  tiktok: {
    category: "video",
    description: "Short-form videos with custom sound and caption settings",
  },
  threads: {
    category: "social",
    description: "Text threads, single photos, and link posts",
  },
};

const PLATFORM_CATALOG = PLATFORM_IDS.map((id) => ({
  id,
  name: platformDisplayName(id),
  ...PLATFORM_PRESENTATION[id],
}));

const CONNECTION_FILTER_OPTIONS: readonly ("all" | ConnectionStatus)[] = [
  "all",
  ...CONNECTION_STATUSES,
];

type StatusFilter = "all" | ConnectionStatus;

export interface ChannelsViewProps {
  initialTab?: "connected" | "all";
}

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
  const accountsScrollRef = useSmoothScrollContainer();
  const profilesScrollRef = useSmoothScrollContainer();

  const pathname = usePathname();
  const navigate = useNavigate();
  const searchParams = useSearchParams();
  const oauthOutcome = searchParams.get("oauth");
  const providerParam = searchParams.get("provider");
  const oauthMessage = oauthOutcomeMessage(oauthOutcome, providerParam, language);
  const oauthToastShown = useRef(false);

  useEffect(() => {
    if (oauthOutcome !== "connected" || !oauthMessage || oauthToastShown.current) return;
    oauthToastShown.current = true;
    toast(oauthMessage, {
      description: t("The Channel is ready to publish and schedule."),
      variant: "success",
    });
    const next = new URLSearchParams(searchParams);
    next.delete("oauth");
    next.delete("provider");
    const query = next.toString();
    navigate(`${pathname}${query ? `?${query}` : ""}`, { replace: true });
  }, [navigate, oauthMessage, oauthOutcome, pathname, searchParams, t]);

  const platformsQuery = usePlatforms(scope);
  const capabilitiesQuery = usePlatformCapabilities(scope);
  const disconnectMutation = useDisconnectPlatform(scope);
  const oauthMutation = useStartPlatformOAuth(scope);
  const tabParam = searchParams.get("tab");
  const shouldOpenAdd = initialTab === "all" || tabParam === "all" || tabParam === "add";

  const [addAccountOpen, setAddAccountOpen] = useState(shouldOpenAdd);
  const [prevShouldOpenAdd, setPrevShouldOpenAdd] = useState(shouldOpenAdd);

  if (shouldOpenAdd !== prevShouldOpenAdd) {
    setPrevShouldOpenAdd(shouldOpenAdd);
    if (shouldOpenAdd) {
      setAddAccountOpen(true);
    }
  }

  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<Error | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<PlatformAccount | null>(null);
  const [search, setSearch] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<BrandProfile | null>(null);
  const [directoryTab, setDirectoryTab] = useState<"accounts" | "profiles">("accounts");

  const selectionScopeKey = `${scope.workspaceId ?? ""}/${selectedBrandProfileId ?? ""}`;
  const [selection, setSelection] = useState(() => ({
    scope: selectionScopeKey,
    ids: new Set<string>(),
  }));
  const selectedIds = selection.ids;

  const [bulkTargets, setBulkTargets] = useState<PlatformAccount[] | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const shownDisconnectTarget = useLatchedValue(disconnectTarget);
  const shownBulkTargets = useLatchedValue(bulkTargets);
  if (selection.scope !== selectionScopeKey) {
    setSelection({ scope: selectionScopeKey, ids: new Set<string>() });
    setBulkTargets(null);
    setDisconnectTarget(null);
  }

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
    ? PLATFORM_CATALOG.filter(
        (p) =>
          p.name.toLowerCase().includes(normalizedSearch) ||
          p.description.toLowerCase().includes(normalizedSearch),
      )
    : PLATFORM_CATALOG;

  const platformChannelSummary = useMemo(() => {
    const counts = new Map<string, number>();
    const profileIds = new Map<string, Set<string>>();
    for (const account of integrations) {
      const key = account.providerIdentifier.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      let profiles = profileIds.get(key);
      if (!profiles) {
        profiles = new Set();
        profileIds.set(key, profiles);
      }
      if (account.brandProfileId) profiles.add(account.brandProfileId);
    }
    return { counts, profileIds };
  }, [integrations]);

  const accountProfileIds = useMemo(
    () => accounts.map((account) => account.brand_profile_id),
    [accounts],
  );

  const profileById = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile])),
    [brandProfiles],
  );

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

  const resetAccountFilters = () => {
    setAccountQuery("");
    setSelectedPlatforms([]);
    setSelectedBrandProfileId(null);
    setStatusFilter("all");
  };

  const handleConnect = async (platformId: Platform) => {
    if (!isAdmin) return;
    setConnectingPlatform(platformId);
    setConnectError(null);
    try {
      const result = await oauthMutation.mutateAsync({ platform: platformId });
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

  const handleConfirmDisconnect = async () => {
    const target = disconnectTarget;
    if (!isAdmin || !target) return;
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

  const openBulkDisconnect = () => {
    if (!isAdmin) return;
    const targets = accounts.filter((account) => selectedIds.has(account.id));
    if (targets.length === 0) return;
    setBulkTargets(targets);
  };

  const handleConfirmBulkDisconnect = async () => {
    const targets = bulkTargets;
    if (!isAdmin || !targets || bulkRunning) return;
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

  const openProfileEditor = (profile?: BrandProfile) => {
    setEditingProfile(profile ?? null);
    setProfileEditorOpen(true);
  };

  return (
    <WorkspaceSurface
      title={t("Channels")}
      description={
        <Trans
          message="{count} connected accounts across {profiles} Brand Profiles."
          values={{
            count: <RollingCount value={accounts.length} />,
            profiles: <RollingCount value={brandProfiles.length} />,
          }}
        />
      }
      className="mx-auto max-w-300"
      actions={
        <>
          {isAdmin && (
            <Button
              onClick={() => setAddAccountOpen(true)}
              disabled={brandProfiles.length === 0}
              aria-describedby={
                brandProfiles.length === 0 ? "add-account-disabled-note" : undefined
              }
              className="max-sm:px-2"
            >
              <Plus className="size-4" />
              {t("Add account")}
            </Button>
          )}
          {isAdmin && (
            <Button variant="outline" onClick={() => openProfileEditor()} className="max-sm:px-2">
              <UserPlus className="size-4" />
              {t("Create Brand Profile")}
            </Button>
          )}
        </>
      }
    >
      {oauthMessage && oauthOutcome !== "connected" && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
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
                Number(selectedPlatforms.length > 0) +
                Number(selectedBrandProfileId !== null) +
                Number(statusFilter !== "all")
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
              <Trans
                message="{count} accounts"
                values={{ count: <RollingCount value={totalMatchingAccounts} /> }}
              />
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
              "min-h-0 flex-1 overflow-auto px-4 pb-6 sm:px-6",
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
                selectionDisabled={bulkRunning || !isAdmin}
                onReconnect={
                  isAdmin ? (account) => void handleConnect(account.platform) : undefined
                }
                onDisconnect={isAdmin ? setDisconnectTarget : undefined}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="profiles"
          ref={profilesScrollRef}
          className="mt-0 min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3.5 sm:px-6"
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

      <BrandProfileDialog
        open={profileEditorOpen}
        onOpenChange={(open) => {
          setProfileEditorOpen(open);
          if (!open) setEditingProfile(null);
        }}
        profile={editingProfile}
        onSuccess={(profile) => {
          if (editingProfile === null) {
            setSelectedBrandProfileId(profile.id);
            setAddAccountOpen(true);
          }
        }}
      />

      <CenterDialog
        open={isAdmin && addAccountOpen}
        onOpenChange={(open) => setAddAccountOpen(isAdmin && open)}
      >
        <CenterDialogContent closeLabel={t("Close")} className="max-w-xl">
          <CenterDialogHeader>
            <CenterDialogTitle>{t("Connect social account")}</CenterDialogTitle>
            <CenterDialogDescription>
              {t(
                "Choose a provider to authorize. After authorization, choose which Brand Profile owns the connected Channel.",
              )}
            </CenterDialogDescription>
          </CenterDialogHeader>

          <div className="min-w-0 space-y-4 py-2">
            <div className="space-y-3">
              <label htmlFor="platform-search" className="block text-xs font-semibold text-ink">
                {t("Social Channels")}
              </label>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-ink-3" />
                <Input
                  id="platform-search"
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
                <div className="flex flex-col gap-2.5 sm:max-h-[48dvh] sm:overflow-y-auto sm:overscroll-contain sm:pr-1">
                  {filteredPlatforms.map((platform) => {
                    const capability = capabilityByPlatform.get(platform.id);
                    const platformChannelCount =
                      platformChannelSummary.counts.get(platform.id) ?? 0;
                    const claimedProfiles = platformChannelSummary.profileIds.get(platform.id);
                    const eligibleProfileCount = claimedProfiles
                      ? brandProfiles.filter((profile) => !claimedProfiles.has(profile.id)).length
                      : brandProfiles.length;
                    const noEligibleProfile =
                      brandProfiles.length === 0 || eligibleProfileCount === 0;
                    const connectUnavailable = capability?.connect_available === false;
                    const isConnecting = connectingPlatform === platform.id;

                    return (
                      <div
                        key={platform.id}
                        className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-3 transition-colors hover:border-line-strong sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <PlatformIcon provider={platform.id} className="size-8 shrink-0" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-ink text-[13.5px]">
                                {platform.name}
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

                        <div className="flex min-w-0 flex-col items-start gap-2 sm:max-w-[45%] sm:shrink-0 sm:items-end">
                          {platformChannelCount > 0 && (
                            <div className="flex max-w-full items-center gap-1.5 text-xs text-ink-2">
                              <Check className="size-3.5 shrink-0 text-green" aria-hidden="true" />
                              <span>
                                {t("{count} connected accounts", {
                                  count: platformChannelCount,
                                })}
                              </span>
                            </div>
                          )}
                          <Button
                            size="sm"
                            variant="default"
                            disabled={connectUnavailable || isConnecting || noEligibleProfile}
                            onClick={() => void handleConnect(platform.id)}
                            className="rounded-control text-xs font-semibold h-8 px-3.5 bg-primary text-primary-foreground shadow-btn hover:bg-primary/90"
                          >
                            {connectUnavailable
                              ? t("Unavailable")
                              : noEligibleProfile
                                ? t("No eligible Brand Profile")
                                : isConnecting
                                  ? t("Redirecting…")
                                  : t("Connect")}
                          </Button>
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

      {isAdmin && (
        <BulkSelectionBar
          count={selectedIds.size}
          actionLabel={t("Disconnect")}
          actionIcon={Unplug}
          busyLabel={t("Disconnecting…")}
          busy={bulkRunning}
          onClear={() => setSelection((prev) => ({ ...prev, ids: new Set<string>() }))}
          onAction={openBulkDisconnect}
        />
      )}
    </WorkspaceSurface>
  );
}
