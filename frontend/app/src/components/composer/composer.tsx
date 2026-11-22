import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codePointLength } from "@meltiply/domain";
import { Schema } from "effect";
import { persistProfileCopies, type ProfileCopy, type ProfileCopyProgress } from "./profile-copies";
import {
  hasCookieConsent,
  readFunctionalStorage,
  subscribeCookieConsent,
  writeFunctionalStorage,
} from "@meltiply/ui/cookie-consent";

import { useWorkspace } from "@/context/workspace.context";
import { DestinationSelector } from "@/components/workspace/destination-selector";
import type { WorkspaceView } from "@/lib/navigation";
import {
  PlatformSettings,
  providerDescriptorFor,
  settingsForAttachmentOrder,
  type PostTargetDraft,
} from "./platform-settings";
import { ScheduleDateTime } from "./schedule-date-time";
import { MediaPreview } from "@/components/media/media-preview";
import { Button } from "@meltiply/ui/button";
import { Textarea } from "@meltiply/ui/textarea";
import { Switch } from "@meltiply/ui/switch";
import { Input } from "@meltiply/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { PlatformIcon } from "@/components/primitives/platform-icon";
import { Alert } from "@meltiply/ui/alert";
import {
  CenterAlertDialog,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";

import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { cn } from "@meltiply/ui/utils";
import { toast } from "@meltiply/ui/toast";
import {
  Image as ImageIcon,
  Calendar,
  Send,
  Save,
  AlertCircle,
  Check,
  X,
  Layers,
  Loader2,
  Upload,
  Pause,
  Play,
  ChevronUp,
  ChevronDown,
  Replace,
  Plus,
  type LucideIcon,
} from "lucide-react";
import type { ChannelIntegration } from "@/api/types";
import type {
  Asset,
  CreatePostInput,
  Distribution,
  PlatformCapability,
  Post,
  TikTokPublishingRequirements,
} from "@/types";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  useAsset,
  useCreatePost,
  usePlatformCapabilities,
  usePlatforms,
  usePost,
  usePublishingPreferences,
  useSchedulePost,
  useUpdatePost,
  useQueues,
} from "@/lib/queries";
import { createAssetUpload, type AssetUploadStatus, type AssetUploadTask } from "@/lib/upload";
import { RollingCount } from "@meltiply/ui/rolling-count";
import {
  captionWithSignature,
  defaultSignatureTemplate,
  instantToWallClock,
  resolveSignature,
  wallClockToInstant,
} from "@/lib/publishing-preferences";
import { platformDisplayName } from "@/lib/platforms";
import { resolvePublicationStatus } from "@/lib/publication-status";
import { Trans, useI18n } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { userFacingErrorMessage } from "@/lib/frontend-errors";

interface ChannelOverride {
  content: string;
  hasOverride: boolean;
  settings: Record<string, unknown>;
  signature?: string | null;
}

const PUBLISH_MODES = ["draft", "queue", "schedule", "now"] as const;
type PublishMode = (typeof PUBLISH_MODES)[number];

function publishModeOption(mode: PublishMode, t: (message: string) => string): string {
  switch (mode) {
    case "draft":
      return t("Draft");
    case "queue":
      return t("Queue");
    case "schedule":
      return t("Schedule");
    case "now":
      return t("Now");
  }
}

function publishModeAction(
  mode: PublishMode,
  postId: string | null,
  t: (message: string) => string,
): string {
  if (mode === "draft") return postId === null ? t("Save Draft") : t("Save");
  if (mode === "schedule") return t("Schedule Post");
  if (mode === "queue") return t("Add to Queue");
  return t("Publish Now");
}

const PUBLISH_MODE_ICONS = { draft: Save, queue: Layers, schedule: Calendar, now: Send } as const;

function captionLength(text: string): number {
  return codePointLength(text);
}

function clampCaption(text: string, limit: number | null): string {
  if (limit === null || codePointLength(text) <= limit) return text;
  return [...text].slice(0, limit).join("");
}

interface AttachmentEntry {
  key: string;
  assetId: string | null;
  name: string;
  mimeType: string | null;
  assetType: Asset["asset_type"] | null;
  uploadStatus: AssetUploadStatus | null;
  percent: number;
  assetStatus: Asset["status"] | null;
  failureMessage: string | null;
  previewUrl: string;
  task: AssetUploadTask | null;
  hasLocalFile: boolean;
}

type ReplacedSelections = ReadonlyArray<readonly [string, number]>;

const composerRecoverySchema = Schema.Struct({
  attachmentOverrides: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  attachments: Schema.Array(
    Schema.Struct({
      assetId: Schema.String,
      assetType: Schema.NullOr(Schema.Literals(["image", "video"])),
      mimeType: Schema.NullOr(Schema.String),
      name: Schema.String,
    }),
  ),
  channelOverrides: Schema.Record(
    Schema.String,
    Schema.Struct({
      content: Schema.String,
      hasOverride: Schema.Boolean,
      settings: Schema.Record(Schema.String, Schema.Unknown),
      signature: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  removedAssetIds: Schema.Array(Schema.String),
  scheduleDate: Schema.String,
  sharedContent: Schema.String,
  updatedAt: Schema.String,
  profileIds: Schema.Array(Schema.String),
  selectedChannelIds: Schema.Array(Schema.String),
  profileCopies: Schema.Record(
    Schema.String,
    Schema.Struct({
      postId: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      scheduledIntent: Schema.optional(Schema.String),
      assets: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  version: Schema.Literal(2),
});
type ComposerRecoveryRecord = typeof composerRecoverySchema.Type;

const recoveryKeyPrefix = "meltiply.composer.v2.";

const terminalUploadStatuses: ReadonlySet<AssetUploadStatus> = new Set([
  "cancelled",
  "complete",
  "completing",
  "failed",
  "processing",
]);

const activeUploadStatuses: ReadonlySet<AssetUploadStatus> = new Set([
  "creating",
  "uploading",
  "paused",
  "offline",
]);

function isUploadCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "UploadCancelledError";
}

function attachmentPhase(
  attachment: AttachmentEntry,
  t: (message: string) => string,
): { failed: boolean; label: string; message: string | null; ready: boolean } {
  const { assetStatus, failureMessage, uploadStatus } = attachment;
  if (uploadStatus === "failed") {
    return {
      failed: true,
      label: t("Failed"),
      message: failureMessage ?? t("Upload failed. Retry or remove this attachment."),
      ready: false,
    };
  }
  if (uploadStatus === "paused")
    return { failed: false, label: t("Paused"), message: null, ready: false };
  if (uploadStatus === "offline")
    return { failed: false, label: t("Offline"), message: null, ready: false };
  if (uploadStatus === "creating") {
    return { failed: false, label: t("Preparing"), message: null, ready: false };
  }
  if (uploadStatus === "uploading") {
    return { failed: false, label: t("Uploading"), message: null, ready: false };
  }
  if (uploadStatus === "cancelled") {
    return { failed: false, label: t("Cancelled"), message: null, ready: false };
  }
  if (assetStatus === "failed") {
    return {
      failed: true,
      label: t("Failed"),
      message: failureMessage ?? t("This attachment could not be processed."),
      ready: false,
    };
  }
  if (
    assetStatus === "pending_upload" ||
    assetStatus === "uploading" ||
    assetStatus === "processing"
  ) {
    return { failed: false, label: t("Processing"), message: null, ready: false };
  }
  return { failed: false, label: t("Ready"), message: null, ready: true };
}

function AttachmentStatusPoller({
  assetId,
  assetStatus,
  onAssetUpdate,
}: {
  assetId: string;
  assetStatus: Asset["status"] | null;
  onAssetUpdate: (asset: Asset) => void;
}) {
  const scope = useSessionScope();
  const assetQuery = useAsset(
    scope,
    assetId,
    assetStatus !== "ready" && assetStatus !== "failed" && assetStatus !== "deleted",
  );
  const asset = assetQuery.data;
  const lastSeenRef = useRef<string>("");
  useEffect(() => {
    if (!asset) return;
    const signature = `${asset.id}:${asset.status}:${asset.failure?.message ?? ""}:${asset.mime_type ?? ""}`;
    if (signature === lastSeenRef.current) return;
    lastSeenRef.current = signature;
    onAssetUpdate(asset);
  }, [asset, onAssetUpdate]);
  return null;
}

function overridesFromPost(
  post: Post,
  platformByAccountId: Readonly<Record<string, string | undefined>>,
): Record<string, ChannelOverride> {
  const overrides: Record<string, ChannelOverride> = {};
  const distributionByAccount = new Map<string, Distribution>();
  for (const distribution of post.distributions) {
    const accountId = distribution.platform_account_id;
    if (accountId && !distributionByAccount.has(accountId)) {
      distributionByAccount.set(accountId, distribution);
    }
  }
  for (const target of post.targets) {
    const platform =
      platformByAccountId[target.platform_account_id] ??
      distributionByAccount.get(target.platform_account_id)?.platform ??
      "";
    const descriptor = providerDescriptorFor(platform);
    const content = target.description_override ?? post.default_text;
    overrides[target.platform_account_id] = {
      content,
      hasOverride:
        target.description_override !== null && target.description_override !== post.default_text,
      settings: settingsForAttachmentOrder(
        descriptor?.readTarget?.(target) ?? {},
        target.attachment_ids ?? post.attachments.map((attachment) => attachment.asset_id),
      ),
      signature: target.signature,
    };
  }
  return overrides;
}

function attachmentOverridesFromPost(post: Post): Record<string, string[]> {
  const overrides: Record<string, string[]> = {};
  for (const target of post.targets) {
    if (target.attachment_ids !== null)
      overrides[target.platform_account_id] = [...target.attachment_ids];
  }
  return overrides;
}

function restoredAttachmentRows(
  previous: AttachmentEntry[],
  record: ComposerRecoveryRecord,
  removedAssetIds: ReadonlySet<string>,
): AttachmentEntry[] {
  const remaining = new Map<string, AttachmentEntry>();
  for (const entry of previous) if (entry.assetId) remaining.set(entry.assetId, entry);
  const rows: AttachmentEntry[] = [];
  for (const attachment of record.attachments) {
    if (removedAssetIds.has(attachment.assetId)) continue;
    const existing = remaining.get(attachment.assetId);
    rows.push(
      existing ?? {
        assetId: attachment.assetId,
        assetStatus: null,
        assetType: attachment.assetType,
        failureMessage: null,
        hasLocalFile: false,
        key: `restored-${attachment.assetId}`,
        mimeType: attachment.mimeType,
        name: attachment.name,
        percent: 100,
        previewUrl: "",
        task: null,
        uploadStatus: null,
      },
    );
    remaining.delete(attachment.assetId);
  }
  for (const entry of previous) {
    if (!entry.assetId || (remaining.has(entry.assetId) && !removedAssetIds.has(entry.assetId))) {
      rows.push(entry);
    }
  }
  return rows;
}

function ComposerSection({
  icon: Icon,
  title,
  action,
  className,
  children,
}: {
  icon?: LucideIcon | string;
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 shrink-0 flex-col gap-3", className)}>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {typeof Icon === "string" ? (
            <PlatformIcon provider={Icon} className="size-4 shrink-0" />
          ) : Icon ? (
            <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          ) : null}
          <h3 className="min-w-0 truncate text-(length:--font-size-ui) font-semibold text-ink">
            {title}
          </h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export interface ComposerProps {
  initialPostId?: string;
  initialDate?: Date | string;
  onPostSuccess?: () => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

export function Composer({ initialPostId, initialDate, onPostSuccess, onNavigate }: ComposerProps) {
  const {
    brandProfiles,
    integrations,
    selectedChannelIds,
    selectedBrandProfileId: collectionProfileId,
    setSelectedChannelIds,
    refreshWorkspace,
  } = useWorkspace();
  const scope = useSessionScope();
  const { t, tStatus, language } = useI18n();
  const profileNames = useMemo(
    () => new Map(brandProfiles.map((profile) => [profile.id, profile.name])),
    [brandProfiles],
  );

  const [createdPostId, setCreatedPostId] = useState<string | null>(null);
  const postId = initialPostId ?? createdPostId;
  const [sharedContent, setSharedContent] = useState("");
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [channelOverrides, setChannelOverrides] = useState<Record<string, ChannelOverride>>({});
  const [attachmentOverrides, setAttachmentOverrides] = useState<Record<string, string[]>>({});
  const [publishMode, setPublishMode] = useState<PublishMode>(
    initialDate !== undefined ? "schedule" : "draft",
  );
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [scheduleDate, setScheduleDate] = useState<string>(() => {
    const seeded = initialDate
      ? instantToWallClock(initialDate, Intl.DateTimeFormat().resolvedOptions().timeZone)
      : "";
    if (seeded) return seeded;
    const fallback = new Date(Date.now() + 1000 * 60 * 60 * 2);
    fallback.setMinutes(fallback.getMinutes() - fallback.getTimezoneOffset());
    return fallback.toISOString().slice(0, 16);
  });
  const scheduleTouchedRef = useRef(false);
  const scheduleTimeZoneRef = useRef(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [hydratedPostId, setHydratedPostId] = useState<string | null>(null);
  const [ownerProfileId, setOwnerProfileId] = useState<string | null>(() =>
    initialPostId === undefined ? collectionProfileId : null,
  );
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>(() =>
    ownerProfileId ? [ownerProfileId] : [],
  );
  const [profileProgress, setProfileProgress] = useState<ProfileCopyProgress[]>([]);
  const profileCopiesRef = useRef(new Map<string, ProfileCopy>());
  const batchAbortRef = useRef<AbortController | null>(null);
  const [functionalConsent, setFunctionalConsent] = useState(() => hasCookieConsent("functional"));
  const [recoveryReadNamespace, setRecoveryReadNamespace] = useState<string | null>(null);
  const [tiktokRequirements, setTikTokRequirements] = useState<
    Record<string, TikTokPublishingRequirements | null>
  >({});
  const [pendingOwnershipAssetIds, setPendingOwnershipAssetIds] = useState<string[] | null>(null);
  const [isDragActive, setDragActive] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    view: WorkspaceView;
    options?: { search?: string };
  } | null>(null);
  const [isSavingBeforeLeave, setIsSavingBeforeLeave] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const tasksRef = useRef(new Map<string, AssetUploadTask>());
  const filesRef = useRef(new Map<string, File>());
  const objectUrlsRef = useRef(new Set<string>());
  const attachmentsRef = useRef<AttachmentEntry[]>([]);
  const attachmentOverridesRef = useRef<Record<string, string[]>>({});
  const recoveryNamespaceRef = useRef("");
  const composerIdentityRef = useRef("");
  const dirtyRef = useRef(false);
  const postIdRef = useRef<string | null>(null);
  const persistedOwnershipRef = useRef(new Set<string>());
  const removedAssetIdsRef = useRef<Set<string>>(new Set());

  const composerIdentity = `${scope.workspaceId ?? "personal"}::${ownerProfileId ?? "all"}::${initialPostId ?? "new"}`;
  const recoveryNamespace = `${scope.workspaceId ?? "personal"}::${ownerProfileId ?? "all"}::${postId ?? "new"}`;
  const [previousComposerIdentity, setPreviousComposerIdentity] = useState(composerIdentity);
  if (previousComposerIdentity !== composerIdentity) {
    setPreviousComposerIdentity(composerIdentity);
    setSelectedProfileIds(ownerProfileId ? [ownerProfileId] : []);
    setProfileProgress([]);
  }
  useEffect(() => {
    recoveryNamespaceRef.current = recoveryNamespace;
    composerIdentityRef.current = composerIdentity;
    postIdRef.current = postId;
  }, [composerIdentity, postId, recoveryNamespace]);
  useEffect(
    () =>
      subscribeCookieConsent(() => {
        setFunctionalConsent(hasCookieConsent("functional"));
      }),
    [],
  );

  const postQuery = usePost(scope, postId ?? "", postId !== null);
  const capabilitiesQuery = usePlatformCapabilities(scope);

  const candidateOwnerId =
    initialPostId !== undefined
      ? postQuery.data?.brand_profile_id
      : (collectionProfileId ?? brandProfiles[0]?.id);
  if (ownerProfileId === null && candidateOwnerId) setOwnerProfileId(candidateOwnerId);
  const createPost = useCreatePost(scope);
  const updatePost = useUpdatePost(scope);
  const schedulePost = useSchedulePost(scope);
  const queueQuery = useQueues(
    scope,
    selectedProfileIds.length === 1 ? selectedProfileIds[0]! : null,
    publishMode === "queue",
  );
  const publishingQueues = useMemo(
    () => queueQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [queueQuery.data],
  );
  const selectedQueue = useMemo(
    () => publishingQueues.find((queue) => queue.id === selectedQueueId),
    [publishingQueues, selectedQueueId],
  );
  const hasSelectedQueue = selectedQueue !== undefined;

  const platformsQuery = usePlatforms(scope, { brandProfileId: null });
  const preferencesQuery = usePublishingPreferences(scope);
  const publishingTimeZone =
    preferencesQuery.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const defaultSignature = defaultSignatureTemplate(
    preferencesQuery.data?.signature_templates ?? [],
  );
  const platformByAccountId = useMemo<Record<string, string | undefined>>(() => {
    const byAccount: Record<string, string | undefined> = {};
    for (const channel of integrations) byAccount[channel.id] = channel.providerIdentifier;
    return byAccount;
  }, [integrations]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setIsDirty(true);
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    attachmentOverridesRef.current = attachmentOverrides;
  }, [attachmentOverrides]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    const tasks = tasksRef.current;
    const files = filesRef.current;
    return () => {
      batchAbortRef.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      for (const task of tasks.values()) void task.cancel();
      tasks.clear();
      files.clear();
    };
  }, []);

  useEffect(() => {
    if (!initialDate || initialPostId || scheduleTouchedRef.current) return;
    scheduleTimeZoneRef.current = publishingTimeZone;
    setScheduleDate(instantToWallClock(initialDate, publishingTimeZone));
  }, [initialDate, initialPostId, publishingTimeZone]);

  const resetComposer = useCallback(() => {
    batchAbortRef.current?.abort();
    profileCopiesRef.current.clear();
    setSharedContent("");
    setAttachments([]);
    setChannelOverrides({});
    setAttachmentOverrides({});
    setSelectedQueueId("");
    setSelectedChannelIds(null);
    setSavedAt(null);
    setHydratedPostId(null);
    setErrorMessage(null);
    setValidationErrors([]);
    setPendingOwnershipAssetIds(null);
    dirtyRef.current = false;
    removedAssetIdsRef.current = new Set();
    persistedOwnershipRef.current = new Set();
    setIsDirty(false);
  }, [setSelectedChannelIds]);

  const cancelledIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (cancelledIdentityRef.current === null) {
      cancelledIdentityRef.current = composerIdentity;
      return;
    }
    if (cancelledIdentityRef.current === composerIdentity) return;
    cancelledIdentityRef.current = composerIdentity;
    for (const task of tasksRef.current.values()) void task.cancel();
    tasksRef.current.clear();
    filesRef.current.clear();
    setCreatedPostId(null);
    resetComposer();
  }, [composerIdentity, resetComposer]);

  const readRecovery = useCallback((): ComposerRecoveryRecord | null => {
    try {
      const raw = readFunctionalStorage(recoveryKeyPrefix + recoveryNamespaceRef.current);
      if (!raw) return null;
      return Schema.decodeUnknownSync(composerRecoverySchema)(JSON.parse(raw));
    } catch {
      return null;
    }
  }, []);

  const writeRecovery = useCallback((record: ComposerRecoveryRecord | null) => {
    try {
      const key = recoveryKeyPrefix + recoveryNamespaceRef.current;
      writeFunctionalStorage(key, record ? JSON.stringify(record) : null);
    } catch {
      return;
    }
  }, []);

  const clearRecoveryAfterSave = useCallback((namespaceAtSubmit: string) => {
    writeFunctionalStorage(recoveryKeyPrefix + namespaceAtSubmit, null);
  }, []);

  useEffect(() => {
    if (!functionalConsent || recoveryReadNamespace !== recoveryNamespace) return;
    if (postId && !dirtyRef.current) return;
    const persisted = attachments
      .map((attachment) => ({ attachment, assetId: attachment.assetId }))
      .filter((row): row is { attachment: AttachmentEntry; assetId: string } =>
        Boolean(row.assetId),
      );
    if (!sharedContent && persisted.length === 0 && !postId) {
      writeRecovery(null);
      return;
    }
    writeRecovery({
      attachmentOverrides,
      attachments: persisted.map(({ attachment, assetId }) => ({
        assetId,
        assetType: attachment.assetType,
        mimeType: attachment.mimeType,
        name: attachment.name,
      })),
      channelOverrides,
      removedAssetIds: [...removedAssetIdsRef.current],
      scheduleDate,
      sharedContent,
      profileIds: selectedProfileIds,
      selectedChannelIds,
      profileCopies: Object.fromEntries(
        [...profileCopiesRef.current].map(([id, copy]) => [
          id,
          { ...copy, assets: Object.fromEntries(copy.assets) },
        ]),
      ),
      updatedAt: new Date().toISOString(),
      version: 2,
    });
  }, [
    attachmentOverrides,
    attachments,
    channelOverrides,
    functionalConsent,
    postId,
    recoveryNamespace,
    recoveryReadNamespace,
    scheduleDate,
    sharedContent,
    selectedProfileIds,
    selectedChannelIds,
    profileProgress,
    writeRecovery,
  ]);

  useEffect(() => {
    const post = postQuery.data;
    if (
      !scope.isSignedIn ||
      ownerProfileId === null ||
      !post ||
      !postId ||
      hydratedPostId === postId
    )
      return;
    if (platformsQuery.isPending) return;
    const channelIds = new Set<string>(post.targets.map((target) => target.platform_account_id));
    for (const distribution of post.distributions) {
      if (distribution.platform_account_id) channelIds.add(distribution.platform_account_id);
    }
    const scheduledAt = post.distributions.find(
      (distribution) => distribution.status === "scheduled" && distribution.scheduled_at,
    )?.scheduled_at;
    const timer = window.setTimeout(() => {
      setHydratedPostId(postId);
      setSharedContent(post.default_text);
      setChannelOverrides(overridesFromPost(post, platformByAccountId));
      setAttachmentOverrides(attachmentOverridesFromPost(post));
      setSelectedChannelIds([...channelIds]);
      if (scheduledAt) {
        scheduleTimeZoneRef.current = publishingTimeZone;
        setScheduleDate(instantToWallClock(scheduledAt, publishingTimeZone, false));
        setPublishMode("schedule");
      }
      if (post.queue_membership) {
        setSelectedQueueId(post.queue_membership.queue_id);
        setPublishMode("queue");
      }
      setSavedAt(post.updated_at);
      setIsDirty(false);
      dirtyRef.current = false;
      removedAssetIdsRef.current = new Set();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    hydratedPostId,
    platformByAccountId,
    platformsQuery.isPending,
    postId,
    postQuery.data,
    publishingTimeZone,
    scope.isSignedIn,
    ownerProfileId,
    setSelectedChannelIds,
  ]);

  useEffect(() => {
    if (!functionalConsent || recoveryReadNamespace === recoveryNamespace) return;
    if (postId && (!postQuery.data || hydratedPostId !== postId)) return;
    const record = readRecovery();
    const shouldRestore =
      record !== null &&
      (!postQuery.data || Date.parse(record.updatedAt) > Date.parse(postQuery.data.updated_at));
    const timer = window.setTimeout(() => {
      if (record && shouldRestore) {
        const removedAssetIds = new Set(record.removedAssetIds);
        removedAssetIdsRef.current = removedAssetIds;
        setAttachments((previous) => restoredAttachmentRows(previous, record, removedAssetIds));
        setSharedContent(record.sharedContent);
        setChannelOverrides(record.channelOverrides);
        setAttachmentOverrides(
          Object.fromEntries(
            Object.entries(record.attachmentOverrides).map(([id, assets]) => [id, [...assets]]),
          ),
        );
        setSelectedProfileIds([...record.profileIds]);
        setSelectedChannelIds([...record.selectedChannelIds]);
        profileCopiesRef.current = new Map(
          Object.entries(record.profileCopies).map(([id, copy]) => [
            id,
            { ...copy, assets: new Map(Object.entries(copy.assets)) },
          ]),
        );
        if (record.scheduleDate) setScheduleDate(record.scheduleDate);
        markDirty();
      }
      setRecoveryReadNamespace(recoveryNamespace);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    functionalConsent,
    hydratedPostId,
    markDirty,
    postId,
    postQuery.data,
    readRecovery,
    recoveryNamespace,
    recoveryReadNamespace,
    setSelectedChannelIds,
  ]);

  const mergeAssetSnapshot = useCallback(
    (
      entry: AttachmentEntry,
      asset: Pick<Asset, "status" | "asset_type" | "failure" | "mime_type" | "title">,
    ): AttachmentEntry => {
      const merged: AttachmentEntry = {
        ...entry,
        assetStatus: asset.status,
        assetType: asset.asset_type,
        failureMessage: asset.failure?.message ?? entry.failureMessage,
        mimeType: asset.mime_type ?? entry.mimeType,
        name: asset.title || entry.name,
        percent: asset.status === "failed" ? entry.percent : 100,
      };
      return merged.assetStatus === entry.assetStatus &&
        merged.failureMessage === entry.failureMessage &&
        merged.name === entry.name &&
        merged.assetType === entry.assetType
        ? entry
        : merged;
    },
    [],
  );

  useEffect(() => {
    const post = postQuery.data;
    if (!post) return;
    const remoteByAssetId = new Map(post.attachments.map((item) => [item.asset_id, item]));
    setAttachments((previous) => {
      let changed = false;
      const seenIds = new Set<string>();
      const next = previous.map((entry) => {
        if (!entry.assetId) return entry;
        seenIds.add(entry.assetId);
        const remote = remoteByAssetId.get(entry.assetId);
        if (!remote) return entry;
        const merged = mergeAssetSnapshot(entry, remote.asset);
        if (merged !== entry) changed = true;
        return merged;
      });
      for (const remote of post.attachments) {
        if (removedAssetIdsRef.current.has(remote.asset_id)) continue;
        if (seenIds.has(remote.asset_id)) continue;
        if (dirtyRef.current) continue;
        next.push({
          assetId: remote.asset_id,
          assetStatus: remote.asset.status,
          assetType: remote.asset.asset_type,
          failureMessage: remote.asset.failure?.message ?? null,
          hasLocalFile: false,
          key: `post-${remote.asset_id}`,
          mimeType: remote.asset.mime_type,
          name: remote.asset.title,
          percent: remote.asset.status === "failed" ? 0 : 100,
          previewUrl: "",
          task: null,
          uploadStatus: null,
        });
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [mergeAssetSnapshot, postQuery.data]);

  const handleAssetUpdate = useCallback(
    (asset: Asset) => {
      setAttachments((previous) => {
        let changed = false;
        const next = previous.map((entry) => {
          if (entry.assetId !== asset.id) return entry;
          const merged = mergeAssetSnapshot(entry, asset);
          if (merged !== entry) changed = true;
          return merged;
        });
        return changed ? next : previous;
      });
    },
    [mergeAssetSnapshot],
  );

  const orderedAssetIds = useCallback(
    () =>
      attachments.map((attachment) => attachment.assetId).filter((id): id is string => Boolean(id)),
    [attachments],
  );
  useEffect(() => {
    const assetIds = pendingOwnershipAssetIds;
    if (!postId || !assetIds || assetIds.length === 0) return;
    const profileId = ownerProfileId;
    if (profileId === null || !selectedProfileIds.includes(profileId)) return;
    const fresh = assetIds.filter(
      (assetId) =>
        !persistedOwnershipRef.current.has(assetId) && !removedAssetIdsRef.current.has(assetId),
    );
    if (fresh.length === 0) return;
    for (const assetId of fresh) persistedOwnershipRef.current.add(assetId);
    const attachmentIds = [...orderedAssetIds()];
    const claimed = new Set(attachmentIds);
    for (const assetId of fresh) {
      if (claimed.has(assetId)) continue;
      attachmentIds.push(assetId);
      claimed.add(assetId);
    }
    void updatePost
      .mutateAsync({
        id: postId,
        input: { brand_profile_id: profileId, attachment_ids: attachmentIds },
      })
      .catch(() => {});
  }, [
    orderedAssetIds,
    pendingOwnershipAssetIds,
    postId,
    ownerProfileId,
    selectedProfileIds,
    updatePost,
  ]);

  const selectedChannels = useMemo(() => {
    const selectedIds = new Set(selectedChannelIds);
    const profileIds = new Set(selectedProfileIds);
    return integrations.filter(
      (channel: ChannelIntegration) =>
        channel.brandProfileId !== null &&
        profileIds.has(channel.brandProfileId) &&
        selectedIds.has(channel.id),
    );
  }, [integrations, selectedProfileIds, selectedChannelIds]);

  const targetLabels = useMemo(() => {
    const perProvider = new Map<string, number>();
    for (const channel of selectedChannels) {
      const provider = channel.providerIdentifier.toLowerCase();
      perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    for (const channel of selectedChannels) {
      const provider = channel.providerIdentifier.toLowerCase();
      const platformName = platformDisplayName(channel.providerIdentifier);
      labels.set(
        channel.id,
        (perProvider.get(provider) ?? 0) > 1 ? `${platformName} · ${channel.name}` : platformName,
      );
    }
    return labels;
  }, [selectedChannels]);

  const targetLabelFor = useCallback(
    (channel: ChannelIntegration): string =>
      targetLabels.get(channel.id) ?? platformDisplayName(channel.providerIdentifier),
    [targetLabels],
  );

  const capabilityByPlatform = useMemo(() => {
    const byPlatform = new Map<string, PlatformCapability>();
    for (const capability of capabilitiesQuery.data ?? []) {
      const platform = capability.platform.toLowerCase();
      if (!byPlatform.has(platform)) byPlatform.set(platform, capability);
    }
    return byPlatform;
  }, [capabilitiesQuery.data]);

  const captionLimitFor = useCallback(
    (channel: ChannelIntegration): number | null =>
      capabilityByPlatform.get(channel.providerIdentifier.toLowerCase())?.max_caption_length ??
      null,
    [capabilityByPlatform],
  );

  const sharedCaptionLimit = useMemo(() => {
    let limit: number | null = null;
    for (const channel of selectedChannels) {
      const channelLimit = captionLimitFor(channel);
      if (channelLimit === null) continue;
      limit = limit === null ? channelLimit : Math.min(limit, channelLimit);
    }
    return limit;
  }, [captionLimitFor, selectedChannels]);

  const isAtSharedCaptionLimit =
    sharedCaptionLimit !== null && captionLength(sharedContent) >= sharedCaptionLimit;

  const handleRequirementsChange = useCallback(
    (channelId: string, requirements: TikTokPublishingRequirements | null) => {
      setTikTokRequirements((previous) =>
        previous[channelId] === requirements
          ? previous
          : { ...previous, [channelId]: requirements },
      );
    },
    [],
  );

  const resolvedContentFor = useCallback(
    (channelId: string): string =>
      channelOverrides[channelId]?.hasOverride
        ? (channelOverrides[channelId]?.content ?? "")
        : sharedContent,
    [channelOverrides, sharedContent],
  );

  const scheduleInstant = useCallback(
    () => wallClockToInstant(scheduleDate, publishingTimeZone),
    [publishingTimeZone, scheduleDate],
  );

  useEffect(() => {
    const previous = scheduleTimeZoneRef.current;
    if (previous === publishingTimeZone) return;
    scheduleTimeZoneRef.current = publishingTimeZone;
    if (scheduleTouchedRef.current) return;
    const instant = wallClockToInstant(scheduleDate, previous);
    if (instant) setScheduleDate(instantToWallClock(instant, publishingTimeZone, false));
  }, [publishingTimeZone, scheduleDate]);

  const signatureFor = useCallback(
    (channel: ChannelIntegration): string | null => {
      const saved = channelOverrides[channel.id];
      if (saved && Object.hasOwn(saved, "signature")) return saved.signature ?? null;
      if (!defaultSignature) return null;
      return resolveSignature(defaultSignature.body, {
        brandProfileName: profileNames.get(channel.brandProfileId) ?? "",
        channelName: channel.name,
        platform: channel.providerIdentifier,
      });
    },
    [channelOverrides, defaultSignature, profileNames],
  );

  const attachmentsByAssetId = useMemo(() => {
    const map = new Map<string, AttachmentEntry>();
    for (const attachment of attachments) {
      if (attachment.assetId) map.set(attachment.assetId, attachment);
    }
    return map;
  }, [attachments]);

  const distributionByAccountId = useMemo(() => {
    const map = new Map<string, Post["distributions"][number]>();
    for (const item of postQuery.data?.distributions ?? []) {
      if (item.platform_account_id && !map.has(item.platform_account_id)) {
        map.set(item.platform_account_id, item);
      }
    }
    return map;
  }, [postQuery.data?.distributions]);

  const attachmentsForChannel = useCallback(
    (channelId: string): AttachmentEntry[] => {
      const override = attachmentOverrides[channelId];
      if (!override) return attachments;
      const ordered: AttachmentEntry[] = [];
      for (const assetId of override) {
        const attachment = attachmentsByAssetId.get(assetId);
        if (attachment) ordered.push(attachment);
      }
      return ordered;
    },
    [attachmentOverrides, attachments, attachmentsByAssetId],
  );

  const buildTargets = useCallback(
    (purpose: "draft" | "publication" = "draft"): PostTargetDraft[] => {
      return selectedChannels.map((channel) => {
        const override = channelOverrides[channel.id];
        const target: PostTargetDraft = { platform_account_id: channel.id };
        const channelAttachments = attachmentsForChannel(channel.id);
        providerDescriptorFor(channel.providerIdentifier)?.applyTarget?.(
          target,
          settingsForAttachmentOrder(
            override?.settings ?? {},
            channelAttachments.map((attachment) => attachment.assetId ?? attachment.key),
          ),
          channelAttachments.flatMap((attachment) =>
            attachment.assetType ? [attachment.assetType] : [],
          ),
          tiktokRequirements[channel.id] ?? null,
          purpose,
        );
        target.description_override = override?.hasOverride ? override.content : null;
        target.signature = signatureFor(channel);
        const attachmentIds = attachmentOverrides[channel.id];
        if (attachmentIds) target.attachment_ids = [...attachmentIds];
        return target;
      });
    },
    [
      attachmentOverrides,
      attachmentsForChannel,
      channelOverrides,
      selectedChannels,
      signatureFor,
      tiktokRequirements,
    ],
  );

  const handleChannelOverrideChange = useCallback(
    (channelId: string, updates: Partial<ChannelOverride>) => {
      setChannelOverrides((previous) => ({
        ...previous,
        [channelId]: {
          ...previous[channelId],
          content: previous[channelId]?.content ?? sharedContent,
          hasOverride: previous[channelId]?.hasOverride ?? false,
          settings: previous[channelId]?.settings ?? {},
          ...updates,
          ...(updates.settings
            ? {
                settings: settingsForAttachmentOrder(
                  updates.settings,
                  attachmentsForChannel(channelId).map(
                    (attachment) => attachment.assetId ?? attachment.key,
                  ),
                ),
              }
            : {}),
        },
      }));
      markDirty();
    },
    [markDirty, sharedContent, attachmentsForChannel],
  );

  const startUpload = useCallback(
    (file: File, key: string, index: number | null, replaced: ReplacedSelections | null) => {
      const brandProfileId = ownerProfileId;
      if (!scope.isSignedIn || brandProfileId === null) return;
      const identityAtStart = composerIdentityRef.current;
      let previewUrl = "";
      try {
        previewUrl = URL.createObjectURL(file);
        objectUrlsRef.current.add(previewUrl);
      } catch {
        previewUrl = "";
      }
      const entry: AttachmentEntry = {
        assetId: null,
        assetStatus: "pending_upload",
        assetType: file.type.startsWith("video/") ? "video" : "image",
        failureMessage: null,
        key,
        mimeType: file.type,
        name: file.name,
        hasLocalFile: true,
        percent: 0,
        previewUrl,
        task: null,
        uploadStatus: "creating",
      };
      setAttachments((previous) => {
        if (index === null) return [...previous, entry];
        return [...previous.slice(0, index), entry, ...previous.slice(index)];
      });
      filesRef.current.set(key, file);
      markDirty();

      const patch = (changes: Partial<AttachmentEntry>) => {
        if (composerIdentityRef.current !== identityAtStart) return;
        setAttachments((previous) =>
          previous.map((item) => (item.key === key ? { ...item, ...changes } : item)),
        );
      };

      const adoptReplacedAsset = (newAssetId: string) => {
        if (!replaced || replaced.length === 0) return;
        setAttachmentOverrides((previous) => {
          let changed = false;
          const next = { ...previous };
          for (const [channelId, position] of replaced) {
            const current = next[channelId];
            if (!current || current.includes(newAssetId)) continue;
            const ordered = [...current];
            ordered.splice(Math.min(position, ordered.length), 0, newAssetId);
            next[channelId] = ordered;
            changed = true;
          }
          return changed ? next : previous;
        });
      };
      const task = createAssetUpload({
        brandProfileId,
        file,
        onProgress: (percent) => patch({ percent }),
        onSessionStart: (assetId) => {
          patch({ assetId });
          if (composerIdentityRef.current !== identityAtStart) return;
          adoptReplacedAsset(assetId);
          if (postIdRef.current) {
            setPendingOwnershipAssetIds((previous) => [
              ...(previous ?? []).filter((id) => id !== assetId),
              assetId,
            ]);
          }
        },
        onStatusChange: (uploadStatus) => {
          patch({ uploadStatus });
          if (
            uploadStatus === "failed" ||
            uploadStatus === "cancelled" ||
            terminalUploadStatuses.has(uploadStatus)
          ) {
            tasksRef.current.delete(key);
          }
        },
        workspaceId: scope.workspaceId,
      });
      tasksRef.current.set(key, task);
      patch({ task });
      void task.result
        .then((asset) => {
          tasksRef.current.delete(key);
          if (composerIdentityRef.current !== identityAtStart) return;
          adoptReplacedAsset(asset.id);
          setAttachments((previous) =>
            previous.map((item) =>
              item.key === key
                ? {
                    ...item,
                    assetId: asset.id,
                    assetStatus: asset.status,
                    assetType: asset.asset_type,
                    failureMessage: asset.failure?.message ?? null,
                    mimeType: asset.mime_type ?? item.mimeType,
                    percent: 100,
                    task: null,
                    uploadStatus: asset.status === "processing" ? "processing" : "complete",
                  }
                : item,
            ),
          );
        })
        .catch((error: unknown) => {
          tasksRef.current.delete(key);
          if (composerIdentityRef.current !== identityAtStart) return;
          setAttachments((previous) =>
            previous.map((item) =>
              item.key === key
                ? {
                    ...item,
                    failureMessage: userFacingErrorMessage(error, language),
                    percent: item.percent,
                    task: null,
                    uploadStatus: isUploadCancellation(error) ? "cancelled" : "failed",
                  }
                : item,
            ),
          );
        });
    },
    [language, markDirty, scope.isSignedIn, scope.workspaceId, ownerProfileId],
  );

  const detachAttachmentRow = useCallback((target: AttachmentEntry): string | null => {
    const task = target.task ?? tasksRef.current.get(target.key);
    tasksRef.current.delete(target.key);
    filesRef.current.delete(target.key);
    if (task) void task.cancel();
    if (target.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
      objectUrlsRef.current.delete(target.previewUrl);
    }
    setAttachments((previous) => previous.filter((entry) => entry.key !== target.key));
    return target.assetId;
  }, []);

  const forgetDetachedAsset = useCallback((assetId: string | null): ReplacedSelections => {
    if (!assetId) return [];
    removedAssetIdsRef.current.add(assetId);
    setPendingOwnershipAssetIds((previous) =>
      previous ? previous.filter((id) => id !== assetId) : previous,
    );
    const positions: Array<[string, number]> = [];
    for (const [channelId, assetIds] of Object.entries(attachmentOverridesRef.current)) {
      const position = assetIds.indexOf(assetId);
      if (position >= 0) positions.push([channelId, position]);
    }
    if (positions.length > 0) {
      setAttachmentOverrides((previous) => {
        let changed = false;
        const next: Record<string, string[]> = {};
        for (const [channelId, assetIds] of Object.entries(previous)) {
          const kept = assetIds.filter((id) => id !== assetId);
          if (kept.length !== assetIds.length) changed = true;
          next[channelId] = kept;
        }
        return changed ? next : previous;
      });
    }
    return positions;
  }, []);

  const replaceAttachmentRow = useCallback(
    (file: File, key: string, index: number) => {
      const outgoing = attachmentsRef.current[index];
      if (!outgoing) {
        startUpload(file, key, index, null);
        return;
      }
      startUpload(file, key, index, forgetDetachedAsset(detachAttachmentRow(outgoing)));
    },
    [detachAttachmentRow, forgetDetachedAsset, startUpload],
  );

  const handleFilesSelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      const replaceKey = replaceTargetRef.current;
      replaceTargetRef.current = null;
      if (files.length === 0) return;
      const index = replaceKey
        ? attachmentsRef.current.findIndex((attachment) => attachment.key === replaceKey)
        : -1;
      files.forEach((file, offset) => {
        const key = `upload-${crypto.randomUUID()}`;
        if (offset === 0 && index >= 0) {
          replaceAttachmentRow(file, key, index);
          return;
        }
        startUpload(file, key, index >= 0 ? index + offset : null, null);
      });
    },
    [replaceAttachmentRow, startUpload],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      const brandProfileId = ownerProfileId;
      if (!scope.isSignedIn || brandProfileId === null) {
        toast(t("Upload failed"), {
          variant: "error",
          description: t("Select a Brand Profile before uploading media."),
        });
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      files.forEach((file) => {
        const key = `upload-${crypto.randomUUID()}`;
        startUpload(file, key, null, null);
      });
    },
    [scope.isSignedIn, ownerProfileId, startUpload, t],
  );

  const handleRemoveAttachment = useCallback(
    (key: string) => {
      const target = attachmentsRef.current.find((attachment) => attachment.key === key);
      if (!target) return;
      forgetDetachedAsset(detachAttachmentRow(target));
      markDirty();
    },
    [detachAttachmentRow, forgetDetachedAsset, markDirty],
  );

  const handleMoveAttachment = useCallback(
    (index: number, delta: number) => {
      setAttachments((previous) => {
        const target = index + delta;
        if (target < 0 || target >= previous.length) return previous;
        const next = [...previous];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  const handleRetryUpload = useCallback(
    (key: string) => {
      const file = filesRef.current.get(key);
      const index = attachmentsRef.current.findIndex((attachment) => attachment.key === key);
      if (!file || index < 0) return;
      replaceAttachmentRow(file, `upload-retry-${crypto.randomUUID()}`, index);
    },
    [replaceAttachmentRow],
  );

  const handleToggleChannelAttachment = useCallback(
    (channelId: string, assetId: string) => {
      setAttachmentOverrides((previous) => {
        const ordered = attachmentsRef.current
          .map((attachment) => attachment.assetId)
          .filter((id): id is string => Boolean(id));
        const current = previous[channelId] ?? ordered;
        const next = current.includes(assetId)
          ? current.filter((id) => id !== assetId)
          : ordered.filter((id) => current.includes(id) || id === assetId);
        return { ...previous, [channelId]: next };
      });
      markDirty();
    },
    [markDirty],
  );

  const handleSetChannelAttachments = useCallback(
    (channelId: string, attachmentIds: string[] | null) => {
      setAttachmentOverrides((previous) => {
        const next = { ...previous };
        if (attachmentIds === null) delete next[channelId];
        else next[channelId] = attachmentIds;
        return next;
      });
      markDirty();
    },
    [markDirty],
  );

  const providerValidationErrors = useMemo(
    () =>
      selectedChannels.flatMap(
        (channel) =>
          providerDescriptorFor(channel.providerIdentifier)?.validate?.({
            channelName: channel.name,
            settings: channelOverrides[channel.id]?.settings ?? {},
            capability: capabilityByPlatform.get(channel.providerIdentifier.toLowerCase()),
            requirements: tiktokRequirements[channel.id] ?? null,
            mediaKinds: attachmentsForChannel(channel.id).flatMap((attachment) =>
              attachment.assetType ? [attachment.assetType] : [],
            ),
            t,
          }) ?? [],
      ),
    [
      selectedChannels,
      channelOverrides,
      capabilityByPlatform,
      tiktokRequirements,
      attachmentsForChannel,
      t,
    ],
  );

  const validateSubmission = useCallback(
    (type: PublishMode): string[] => {
      const errors: string[] = [];
      const starting = attachments.filter((attachment) => attachment.assetId === null);

      if (selectedProfileIds.length === 0 || ownerProfileId === null) {
        errors.push(t("Select a Brand Profile before publishing."));
      }
      if (type !== "draft" && selectedChannels.length === 0) {
        errors.push(t("Please select at least one destination channel."));
      }
      if (type !== "draft") {
        const targetedProfiles = new Set(selectedChannels.map((channel) => channel.brandProfileId));
        for (const profileId of selectedProfileIds) {
          if (!targetedProfiles.has(profileId)) {
            errors.push(
              t("{name}: select at least one destination channel.", {
                name: profileNames.get(profileId) ?? t("Unknown profile"),
              }),
            );
          }
        }
      }
      const hostedContentChannels = new Set(
        selectedChannels
          .filter((channel) => {
            const platform = channel.providerIdentifier.toLowerCase();
            const settings = channelOverrides[channel.id]?.settings;
            return (
              (platform === "facebook" &&
                ((typeof settings?.link === "string" && settings.link.trim()) ||
                  ["crosspost", "ab_test", "live"].includes(String(settings?.post_type ?? "")))) ||
              (platform === "youtube" && settings?.post_type === "live") ||
              (platform === "threads" &&
                ((typeof settings?.repost_id === "string" && settings.repost_id.trim()) ||
                  (typeof settings?.gif_attachment === "object" &&
                    settings.gif_attachment !== null &&
                    "gif_id" in settings.gif_attachment &&
                    typeof settings.gif_attachment.gif_id === "string" &&
                    settings.gif_attachment.gif_id.trim()) ||
                  (typeof settings?.text_attachment === "object" &&
                    settings.text_attachment !== null &&
                    "plaintext" in settings.text_attachment &&
                    typeof settings.text_attachment.plaintext === "string" &&
                    settings.text_attachment.plaintext.trim())))
            );
          })
          .map((channel) => channel.id),
      );
      if (
        !sharedContent.trim() &&
        attachments.length === 0 &&
        hostedContentChannels.size === 0 &&
        !selectedChannels.some((channel) => resolvedContentFor(channel.id).trim())
      ) {
        errors.push(t("Post must contain text content or at least one media item."));
      }
      if (starting.length > 0) {
        errors.push(
          t("Wait for {count} attachment(s) to finish starting their upload, or remove them.", {
            count: starting.length,
          }),
        );
      }
      if (type === "schedule" && wallClockToInstant(scheduleDate, publishingTimeZone) === null) {
        errors.push(t("Please provide a valid schedule date and time."));
      }
      if (
        type === "queue" &&
        (!hasSelectedQueue ||
          selectedProfileIds.length !== 1 ||
          selectedProfileIds[0] !== ownerProfileId ||
          profileCopiesRef.current.size > 0)
      ) {
        errors.push(t("Choose a Queue in this Post's single Brand Profile before submitting."));
      }
      if (type === "draft") return errors;

      if (capabilitiesQuery.isPending) {
        errors.push(t("Platform publishing limits are still loading; try again in a moment."));
      }
      errors.push(...providerValidationErrors);

      for (const channel of selectedChannels) {
        const name = channel.name;
        const platform = channel.providerIdentifier.toLowerCase();
        const content = resolvedContentFor(channel.id);
        const capability = capabilityByPlatform.get(platform);
        const channelAttachments = attachmentsForChannel(channel.id);
        const channelSignature = signatureFor(channel);
        const finalCaption = captionWithSignature(content, channelSignature);
        const settings = channelOverrides[channel.id]?.settings;
        const youtubeLive = platform === "youtube" && settings?.post_type === "live";
        if (
          !content.trim() &&
          channelAttachments.length === 0 &&
          !hostedContentChannels.has(channel.id)
        ) {
          errors.push(t("{name}: post text is empty for this channel.", { name }));
        }
        if (
          (platform === "instagram" || platform === "facebook") &&
          settings?.post_type === "story" &&
          (finalCaption.trim() || channelSignature)
        ) {
          errors.push(
            t(
              "{name}: Stories do not accept a caption or signature. Clear this Channel's custom text and turn off its signature.",
              { name },
            ),
          );
        }
        const maxCaption =
          platform === "tiktok" &&
          settings?.post_mode !== "inbox" &&
          channelAttachments.some((attachment) => attachment.assetType === "video")
            ? 2_200
            : capability?.max_caption_length;
        if (
          maxCaption !== null &&
          maxCaption !== undefined &&
          captionLength(finalCaption) > maxCaption
        ) {
          errors.push(
            t("{name}: text exceeds the {limit}-character limit for this platform.", {
              name,
              limit: maxCaption,
            }),
          );
        }
        if (
          !youtubeLive &&
          capability?.min_media_count != null &&
          capability.min_media_count > 0 &&
          channelAttachments.length < capability.min_media_count
        ) {
          errors.push(
            t("{name}: requires at least {limit} attachment(s) per post.", {
              name,
              limit: capability.min_media_count,
            }),
          );
        }
        if (
          capability?.max_media_count != null &&
          channelAttachments.length > capability.max_media_count
        ) {
          errors.push(
            t("{name}: accepts at most {limit} attachment(s) per post.", {
              name,
              limit: capability.max_media_count,
            }),
          );
        }
        const acceptedAssetTypes = new Set(capability?.asset_types ?? []);
        const combinedAssetTypes = new Set(capability?.multi_asset_types ?? []);
        if (channelAttachments.length > 1 && capability) {
          const combined = capability.multi_asset_types ?? [];
          if (combined.length === 0) {
            errors.push(t("{name}: cannot publish more than one attachment per post.", { name }));
          } else {
            const hasUnsupported = channelAttachments.some(
              (attachment) => attachment.assetType && !combinedAssetTypes.has(attachment.assetType),
            );
            if (hasUnsupported) {
              errors.push(
                t(
                  "{name}: cannot combine these attachments; a multi-attachment post accepts {types} media only.",
                  { name, types: combined.join(" or ") },
                ),
              );
            }
          }
        }
        for (const attachment of channelAttachments) {
          const assetType = attachment.assetType;
          if (
            assetType &&
            capability &&
            acceptedAssetTypes.size > 0 &&
            !acceptedAssetTypes.has(assetType)
          ) {
            errors.push(
              t("{name}: this channel does not accept {type} media.", { name, type: assetType }),
            );
          }
          const phase = attachmentPhase(attachment, t);
          if (phase.failed) {
            errors.push(
              t("{name}: attachment {file} is not usable — {reason}", {
                name,
                file: attachment.name,
                reason: phase.message ?? t("Failed"),
              }),
            );
          } else if (!phase.ready) {
            errors.push(
              t("{name}: wait for attachment {file} to finish processing before publishing.", {
                name,
                file: attachment.name,
              }),
            );
          }
        }
      }
      return errors;
    },
    [
      attachments,
      attachmentsForChannel,
      capabilityByPlatform,
      capabilitiesQuery.isPending,
      channelOverrides,
      providerValidationErrors,
      resolvedContentFor,
      publishingTimeZone,
      scheduleDate,
      signatureFor,
      hasSelectedQueue,
      ownerProfileId,
      selectedProfileIds,
      profileNames,
      selectedChannels,
      sharedContent,
      t,
    ],
  );

  const validationErrorRows = useMemo(() => {
    const occurrences = new Map<string, number>();
    return validationErrors.map((message) => {
      const occurrence = (occurrences.get(message) ?? 0) + 1;
      occurrences.set(message, occurrence);
      return { key: `${message}#${occurrence}`, message };
    });
  }, [validationErrors]);

  const persistPost = useCallback(
    async (brandProfileId: string): Promise<Post> => {
      const input: CreatePostInput = {
        attachment_ids: orderedAssetIds(),
        brand_profile_id: brandProfileId,
        default_text: sharedContent,
        targets: buildTargets(),
      };
      return postId
        ? await updatePost.mutateAsync({ id: postId, input })
        : await createPost.mutateAsync(input);
    },
    [buildTargets, createPost, orderedAssetIds, postId, sharedContent, updatePost],
  );

  const handleSubmit = useCallback(
    async (type: PublishMode): Promise<boolean> => {
      setErrorMessage(null);
      const errors = validateSubmission(type);
      setValidationErrors(errors);
      if (errors.length > 0) return false;
      if (ownerProfileId === null) return false;
      const brandProfileId = ownerProfileId;
      const recoveryNamespaceAtSubmit = recoveryNamespaceRef.current;
      const composerIdentityAtSubmit = composerIdentityRef.current;

      setIsSubmitting(true);
      try {
        if (
          type !== "queue" &&
          (selectedProfileIds.length !== 1 ||
            selectedProfileIds[0] !== brandProfileId ||
            profileCopiesRef.current.size > 0)
        ) {
          const targetsByProfile = new Map<string, PostTargetDraft[]>();
          const publicationTargetsByProfile = new Map<string, PostTargetDraft[]>();
          const channelsById = new Map(selectedChannels.map((channel) => [channel.id, channel]));
          for (const [purpose, grouped] of [
            ["draft", targetsByProfile],
            ["publication", publicationTargetsByProfile],
          ] as const) {
            if (type === "draft" && purpose === "publication") continue;
            for (const target of buildTargets(purpose)) {
              const profileId = channelsById.get(target.platform_account_id)?.brandProfileId;
              if (!profileId) continue;
              const targets = grouped.get(profileId);
              if (targets) targets.push(target);
              else grouped.set(profileId, [target]);
            }
          }
          const controller = new AbortController();
          batchAbortRef.current = controller;
          setProfileProgress([]);
          const succeeded = await persistProfileCopies({
            profileIds: selectedProfileIds,
            sourceProfileId: brandProfileId,
            sourcePostId: postId,
            sharedContent,
            targetsByProfile,
            publicationTargetsByProfile,
            attachments: attachments.flatMap((attachment) =>
              attachment.assetId
                ? [
                    {
                      assetId: attachment.assetId,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      file: filesRef.current.get(attachment.key),
                    },
                  ]
                : [],
            ),
            mode: type,
            scheduledAt: type === "schedule" ? scheduleInstant() : null,
            workspaceId: scope.workspaceId,
            copies: profileCopiesRef.current,
            signal: controller.signal,
            create: createPost.mutateAsync,
            update: updatePost.mutateAsync,
            schedule: schedulePost.mutateAsync,
            onProgress: (progress) => {
              if (controller.signal.aborted) return;
              setProfileProgress((previous) => [
                ...previous.filter((entry) => entry.profileId !== progress.profileId),
                progress,
              ]);
            },
          });
          if (controller.signal.aborted || composerIdentityRef.current !== composerIdentityAtSubmit)
            return false;
          const anchor = profileCopiesRef.current.get(brandProfileId);
          await refreshWorkspace();
          if (!succeeded) {
            markDirty();
            setErrorMessage(
              t(
                "Some profiles could not be completed. Completed profiles are kept; retry to finish the remaining work.",
              ),
            );
            return false;
          }
          clearRecoveryAfterSave(recoveryNamespaceAtSubmit);
          dirtyRef.current = false;
          setIsDirty(false);
          setSavedAt(
            anchor?.updatedAt ??
              profileCopiesRef.current.get(selectedProfileIds[0])?.updatedAt ??
              null,
          );
          toast(type === "draft" ? t("Drafts saved") : t("Posts queued"), {
            variant: "success",
            description: t("Saved one independent Post per selected Brand Profile."),
          });
          if (type !== "draft") {
            setProfileProgress([]);
            setCreatedPostId(null);
            resetComposer();
            onPostSuccess?.();
          }
          return true;
        }
        const saved = await persistPost(brandProfileId);
        setCreatedPostId(saved.id);
        dirtyRef.current = false;
        removedAssetIdsRef.current = new Set();
        setSavedAt(saved.updated_at);
        setIsDirty(false);
        setHydratedPostId(saved.id);

        if (type === "draft") {
          clearRecoveryAfterSave(recoveryNamespaceAtSubmit);
          await refreshWorkspace();
          toast(t("Draft saved"), {
            variant: "success",
            description: t("Your post text, attachments, and channel settings are stored."),
          });
          return true;
        }

        await schedulePost.mutateAsync({
          id: saved.id,
          input: {
            brand_profile_id: brandProfileId,
            ...(type === "queue"
              ? { queue_id: selectedQueueId }
              : {
                  scheduled_at: type === "schedule" ? scheduleInstant() : null,
                }),
            targets: buildTargets("publication"),
          },
        });
        clearRecoveryAfterSave(recoveryNamespaceAtSubmit);
        setCreatedPostId(null);
        resetComposer();
        toast(
          type === "queue"
            ? t("Post added to Queue")
            : type === "now"
              ? t("Publication queued")
              : t("Post scheduled"),
          {
            variant: "success",
            description:
              type === "now"
                ? t("Distribution to {count} channel(s) has been queued.", {
                    count: selectedChannels.length,
                  })
                : t("Distribution to {count} channel(s) is scheduled.", {
                    count: selectedChannels.length,
                  }),
          },
        );
        await refreshWorkspace();
        onPostSuccess?.();
        return true;
      } catch (error) {
        if (composerIdentityRef.current !== composerIdentityAtSubmit) return false;
        const details =
          error instanceof ApiError
            ? error.details
                .map((detail) => detail.message)
                .filter((message): message is string => Boolean(message))
            : [];
        if (details.length > 0) setValidationErrors(details);
        else setErrorMessage(userFacingErrorMessage(error, language));
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      buildTargets,
      clearRecoveryAfterSave,
      language,
      onPostSuccess,
      persistPost,
      refreshWorkspace,
      resetComposer,
      scheduleInstant,
      schedulePost,
      selectedQueueId,
      ownerProfileId,
      selectedProfileIds,
      selectedChannels,
      attachments,
      sharedContent,
      postId,
      scope.workspaceId,
      createPost.mutateAsync,
      updatePost.mutateAsync,
      markDirty,
      t,
      validateSubmission,
    ],
  );

  const continuePendingNavigation = useCallback(() => {
    if (!pendingNavigation) return;
    const { view, options } = pendingNavigation;
    setPendingNavigation(null);
    onNavigate?.(view, options);
  }, [onNavigate, pendingNavigation]);

  const requestNavigate = useCallback(
    (view: WorkspaceView, options?: { search?: string }) => {
      if (!onNavigate) return;
      if (isDirty && !functionalConsent) {
        setPendingNavigation({ view, options });
        return;
      }
      onNavigate(view, options);
    },
    [functionalConsent, isDirty, onNavigate],
  );

  const saveDraftAndContinue = useCallback(async () => {
    if (isSavingBeforeLeave) return;
    setIsSavingBeforeLeave(true);
    const saved = await handleSubmit("draft");
    setIsSavingBeforeLeave(false);
    if (saved) continuePendingNavigation();
    else setPendingNavigation(null);
  }, [continuePendingNavigation, handleSubmit, isSavingBeforeLeave]);

  const postLoadError = postQuery.error;
  const isPostLoading = postId !== null && !postQuery.data && !postLoadError;
  const profileMismatch =
    postQuery.data !== undefined &&
    ownerProfileId !== null &&
    postQuery.data.brand_profile_id !== ownerProfileId;
  const isInitializing =
    !postLoadError &&
    (isPostLoading ||
      (postId !== null && hydratedPostId !== postId) ||
      (functionalConsent && recoveryReadNamespace !== recoveryNamespace));
  const PublishModeIcon = PUBLISH_MODE_ICONS[publishMode];
  const submitDisabled =
    isSubmitting ||
    isInitializing ||
    Boolean(postLoadError) ||
    !scope.isSignedIn ||
    ownerProfileId === null ||
    profileMismatch ||
    (publishMode !== "draft" && providerValidationErrors.length > 0);

  return (
    <fieldset
      disabled={isInitializing || isSubmitting}
      aria-busy={isInitializing || isSubmitting}
      className="@container flex min-h-0 min-w-0 grow flex-col gap-5 @4xl:overflow-hidden"
    >
      <div className="flex flex-col gap-3 empty:hidden">
        {ownerProfileId === null && (
          <Alert variant="info" className="items-center">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              {t("Choose a Brand Profile to compose, schedule, or publish.")}
            </div>
          </Alert>
        )}
        {profileMismatch && (
          <Alert variant="destructive" className="items-center">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              {t("This post belongs to {name}. Switch to that Brand Profile to edit it.", {
                name:
                  profileNames.get(postQuery.data?.brand_profile_id ?? "") ??
                  t("another Brand Profile"),
              })}
            </div>
          </Alert>
        )}
        {postLoadError && (
          <Alert variant="destructive" className="items-center">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              <span className="font-semibold">{t("Could not load post")}:</span>{" "}
              {userFacingErrorMessage(postLoadError, language)}
            </div>
          </Alert>
        )}

        {errorMessage && (
          <Alert variant="destructive" className="items-center">
            <AlertCircle className="size-4 shrink-0" />
            <div className="flex-1">
              <span className="font-semibold">{t("Submission Error")}:</span> {errorMessage}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setErrorMessage(null)}
              aria-label={t("Dismiss")}
              className="text-red hover:bg-red/20 size-7 p-0"
            >
              <X className="size-4" />
            </Button>
          </Alert>
        )}

        {validationErrors.length > 0 && (
          <Alert variant="destructive" className="flex-col items-start">
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle className="size-4 shrink-0" />
              {t("Please fix the following before submitting:")}
            </div>
            <ul className="list-disc pl-6 flex flex-col gap-0.5">
              {validationErrorRows.map((row) => (
                <li key={row.key}>{row.message}</li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setValidationErrors([])}
              aria-label={t("Dismiss")}
              className="text-red hover:bg-red/20 size-7 p-0 self-end"
            >
              <X className="size-4" />
            </Button>
          </Alert>
        )}
        {profileProgress.length > 0 && (
          <ul
            className="space-y-1 text-xs text-ink-2"
            aria-label={t("Brand Profile progress")}
            aria-live="polite"
          >
            {profileProgress.map((progress) => (
              <li key={progress.profileId}>
                {profileNames.get(progress.profileId) ?? t("Unknown profile")}
                {": "}
                {progress.phase === "failed"
                  ? userFacingErrorMessage(progress.error, language)
                  : progress.phase === "scheduled"
                    ? publishMode === "schedule"
                      ? t("Scheduled")
                      : t("Queued")
                    : progress.phase === "saved"
                      ? t("Draft saved")
                      : progress.phase === "media"
                        ? t("Preparing profile media…")
                        : t("Saving…")}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex min-w-0 grow flex-col gap-6 @4xl:min-h-0 @4xl:flex-1 @4xl:flex-row @4xl:items-stretch">
        <div
          aria-label={t("Post content")}
          tabIndex={0}
          className="hide-scrollbar flex min-w-0 flex-1 flex-col gap-6 @4xl:-my-1 @4xl:-ml-1 @4xl:min-h-0 @4xl:overflow-y-auto @4xl:overscroll-contain @4xl:py-1 @4xl:pr-2 @4xl:pl-1"
        >
          <ComposerSection icon={Layers} title={t("Shared Content")}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Textarea
                  placeholder={t("What do you want to publish?")}
                  aria-label={t("Shared Content")}
                  value={sharedContent}
                  onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                    setSharedContent(clampCaption(event.target.value, sharedCaptionLimit));
                    markDirty();
                  }}
                  autoGrow
                  className="min-h-36 max-h-72 resize-none text-base font-normal bg-field"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-(length:--font-size-micro) text-ink-3">
                  <span>
                    {ownerProfileId !== null && (
                      <Trans
                        message="Targeting {count} channel(s)"
                        values={{ count: <RollingCount value={selectedChannels.length} /> }}
                      />
                    )}
                  </span>
                  <span
                    className={cn("font-mono", isAtSharedCaptionLimit && "text-red")}
                    title={
                      sharedCaptionLimit === null ? t("Character limit unavailable") : undefined
                    }
                  >
                    {t("{count}/{limit} characters", {
                      count: captionLength(sharedContent),
                      limit: sharedCaptionLimit ?? "—",
                    })}
                  </span>
                </div>
              </div>

              <ComposerSection
                icon={ImageIcon}
                title={t("Attached Media ({count})", { count: attachments.length })}
                action={
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        replaceTargetRef.current = null;
                        fileInputRef.current?.click();
                      }}
                      disabled={ownerProfileId === null || !scope.isSignedIn}
                      className="h-7 gap-1.5 px-2 text-(length:--font-size-control)"
                    >
                      <ImageIcon className="size-3.5" />
                      {t("Add Media")}
                    </Button>
                    <Input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      className="hidden"
                      aria-label={t("Add Media")}
                      onChange={handleFilesSelected}
                    />
                  </div>
                }
              >
                <div
                  onDragOver={(event: React.DragEvent<HTMLDivElement>) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className={`rounded-control border border-dashed p-3 transition-colors ${
                    isDragActive ? "border-foreground bg-inset" : "border-line"
                  }`}
                >
                  {attachments.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 @sm:grid-cols-3 @xl:grid-cols-4">
                      {attachments.map((attachment, index) => {
                        const phase = attachmentPhase(attachment, t);
                        const isActive =
                          attachment.uploadStatus !== null &&
                          activeUploadStatuses.has(attachment.uploadStatus);
                        const isPaused = attachment.uploadStatus === "paused";
                        return (
                          <div
                            key={attachment.key}
                            className="relative group aspect-square rounded-control border border-line overflow-hidden bg-hover"
                          >
                            {attachment.assetId !== null && postId === null && (
                              <AttachmentStatusPoller
                                assetId={attachment.assetId}
                                assetStatus={attachment.assetStatus}
                                onAssetUpdate={handleAssetUpdate}
                              />
                            )}
                            <MediaPreview
                              assetId={attachment.assetId ?? ""}
                              assetType={attachment.assetType ?? undefined}
                              hintPath={attachment.mimeType ?? attachment.name}
                              fallbackSrc={attachment.previewUrl}
                              enabled={
                                attachment.assetId !== null && attachment.assetStatus === "ready"
                              }
                              alt={attachment.name || t("media")}
                              className="size-full object-cover"
                              empty={
                                <div className="size-full flex items-center justify-center text-ink-3">
                                  {!phase.ready && !phase.failed ? (
                                    <Loader2 className="size-5 animate-spin" />
                                  ) : (
                                    <ImageIcon className="size-5" />
                                  )}
                                </div>
                              }
                            />
                            <div
                              className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-surface/85 px-1 py-0.5 text-(length:--font-size-micro) text-ink"
                              role="status"
                            >
                              <span className="truncate">
                                {index + 1}. {attachment.name}
                              </span>
                              <span
                                className={
                                  phase.failed
                                    ? "text-red"
                                    : phase.ready
                                      ? "text-green"
                                      : "text-ink-3"
                                }
                              >
                                {phase.label}
                              </span>
                            </div>
                            {isActive && attachment.percent < 100 && (
                              <div
                                className="absolute inset-x-0 top-0 h-1 bg-surface/60"
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={attachment.percent}
                                aria-label={t("Upload progress for {name}", {
                                  name: attachment.name,
                                })}
                              >
                                <div
                                  data-attachment-progress
                                  className="h-1 bg-accent w-[var(--attachment-progress)]"
                                  style={
                                    {
                                      "--attachment-progress": `${attachment.percent}%`,
                                    } as React.CSSProperties
                                  }
                                />
                              </div>
                            )}
                            {phase.message && (
                              <p className="absolute inset-x-0 top-1 px-1 text-(length:--font-size-micro) leading-tight text-red">
                                {phase.message}
                              </p>
                            )}
                            <div className="absolute top-1 right-1 flex max-w-full flex-wrap justify-end gap-0.5 opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                              <Button
                                type="button"
                                variant="default"
                                size="icon"
                                aria-label={t("Move attachment {index} earlier", {
                                  index: index + 1,
                                })}
                                disabled={index === 0}
                                onClick={() => handleMoveAttachment(index, -1)}
                                className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                              >
                                <ChevronUp className="size-3" />
                              </Button>
                              <Button
                                type="button"
                                variant="default"
                                size="icon"
                                aria-label={t("Move attachment {index} later", {
                                  index: index + 1,
                                })}
                                disabled={index === attachments.length - 1}
                                onClick={() => handleMoveAttachment(index, 1)}
                                className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                              >
                                <ChevronDown className="size-3" />
                              </Button>
                              <Button
                                type="button"
                                variant="default"
                                size="icon"
                                aria-label={t("Replace attachment {index}", {
                                  index: index + 1,
                                })}
                                disabled={ownerProfileId === null}
                                onClick={() => {
                                  replaceTargetRef.current = attachment.key;
                                  fileInputRef.current?.click();
                                }}
                                className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                              >
                                <Replace className="size-3" />
                              </Button>
                              {attachment.uploadStatus === "failed" && attachment.hasLocalFile && (
                                <Button
                                  type="button"
                                  variant="default"
                                  size="icon"
                                  aria-label={t("Retry upload of {name}", {
                                    name: attachment.name,
                                  })}
                                  onClick={() => handleRetryUpload(attachment.key)}
                                  className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                                >
                                  <Upload className="size-3" />
                                </Button>
                              )}
                              {isActive &&
                                (isPaused ? (
                                  <Button
                                    type="button"
                                    variant="default"
                                    size="icon"
                                    aria-label={t("Resume upload of {name}", {
                                      name: attachment.name,
                                    })}
                                    onClick={() => attachment.task?.resume()}
                                    className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                                  >
                                    <Play className="size-3" />
                                  </Button>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="default"
                                    size="icon"
                                    aria-label={t("Pause upload of {name}", {
                                      name: attachment.name,
                                    })}
                                    onClick={() => attachment.task?.pause()}
                                    className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                                  >
                                    <Pause className="size-3" />
                                  </Button>
                                ))}
                              {attachment.uploadStatus !== null &&
                              !terminalUploadStatuses.has(attachment.uploadStatus) ? (
                                <Button
                                  type="button"
                                  variant="default"
                                  size="icon"
                                  aria-label={t("Cancel upload of {name}", {
                                    name: attachment.name,
                                  })}
                                  onClick={() => handleRemoveAttachment(attachment.key)}
                                  className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-red hover:text-ink-inverse"
                                >
                                  <X className="size-3" />
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="default"
                                  size="icon"
                                  aria-label={t("Remove attachment {index}", {
                                    index: index + 1,
                                  })}
                                  onClick={() => handleRemoveAttachment(attachment.key)}
                                  className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-red hover:text-ink-inverse"
                                >
                                  <X className="size-3" />
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          replaceTargetRef.current = null;
                          fileInputRef.current?.click();
                        }}
                        disabled={ownerProfileId === null || !scope.isSignedIn}
                        className="aspect-square h-auto w-full flex-col gap-1.5 rounded-control border-dashed font-normal text-ink-3 hover:text-ink"
                      >
                        <Plus className="size-4" />
                        <span className="text-(length:--font-size-micro)">{t("Add Media")}</span>
                      </Button>
                    </div>
                  )}
                  {attachments.length === 0 && (
                    <div className="flex flex-col items-center gap-2 py-5 text-center">
                      <ImageIcon className="size-4 text-ink-3" aria-hidden="true" />
                      <p className="text-(length:--font-size-micro) text-ink-3">
                        {t(
                          "Drag images or videos here, or use Add Media. Attachments keep their order.",
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </ComposerSection>
            </div>
          </ComposerSection>

          {selectedChannels.map((channel: ChannelIntegration) => {
            const override = channelOverrides[channel.id] ?? {
              content: sharedContent,
              hasOverride: false,
              settings: {},
            };
            const distribution = distributionByAccountId.get(channel.id);
            const channelAttachments = attachmentsForChannel(channel.id);
            const channelAttachmentAssetIds = new Set(
              channelAttachments.flatMap((item) => (item.assetId ? [item.assetId] : [])),
            );
            const inheritsAttachments = !attachmentOverrides[channel.id];
            const includesAttachments = inheritsAttachments || channelAttachments.length > 0;
            const channelCaptionLimit = captionLimitFor(channel);
            const channelContent = resolvedContentFor(channel.id);
            const channelSignature = signatureFor(channel);
            const channelCaption = captionWithSignature(channelContent, channelSignature);

            return (
              <section
                key={channel.id}
                aria-label={channel.name}
                className="shrink-0 border-t border-line pt-6"
              >
                <div className="flex flex-col gap-6">
                  <ComposerSection
                    icon={channel.providerIdentifier}
                    title={targetLabelFor(channel)}
                  >
                    {distribution && (
                      <p className="text-(length:--font-size-micro) text-ink-3">
                        {tStatus(resolvePublicationStatus(distribution.status))}
                      </p>
                    )}
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor={`channel-override-text-${channel.id}`}
                        className="text-xs font-medium text-ink-3"
                      >
                        {t("Custom Text for {name}", { name: channel.name })}
                      </label>
                      <Textarea
                        id={`channel-override-text-${channel.id}`}
                        value={channelContent}
                        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                          handleChannelOverrideChange(channel.id, {
                            hasOverride: true,
                            content: clampCaption(event.target.value, channelCaptionLimit),
                          })
                        }
                        autoGrow
                        className="min-h-36 max-h-72 resize-none text-sm"
                      />
                      <span
                        className={cn(
                          "text-(length:--font-size-micro) text-ink-3 self-end font-mono",
                          channelCaptionLimit !== null &&
                            captionLength(channelCaption) >= channelCaptionLimit &&
                            "text-red",
                        )}
                        title={
                          channelCaptionLimit === null
                            ? t("Character limit unavailable")
                            : undefined
                        }
                      >
                        {t("{count}/{limit} characters", {
                          count: captionLength(channelCaption),
                          limit: channelCaptionLimit ?? "—",
                        })}
                      </span>
                      {(channelSignature || defaultSignature) && (
                        <label className="flex min-h-12 items-center justify-between gap-3 text-xs text-ink-3">
                          {t("Include signature for this Channel")}
                          <Switch
                            checked={Boolean(channelSignature)}
                            onCheckedChange={(enabled) =>
                              handleChannelOverrideChange(channel.id, {
                                signature:
                                  enabled && defaultSignature
                                    ? resolveSignature(defaultSignature.body, {
                                        brandProfileName:
                                          profileNames.get(channel.brandProfileId) ?? "",
                                        channelName: channel.name,
                                        platform: channel.providerIdentifier,
                                      })
                                    : null,
                              })
                            }
                          />
                        </label>
                      )}
                      {channelSignature && (
                        <div className="rounded-control border border-line bg-field px-3 py-2">
                          <p className="text-(length:--font-size-micro) font-medium text-ink-3">
                            {t("Signature preview")}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-ink-2">
                            {channelSignature}
                          </p>
                        </div>
                      )}
                    </div>
                    {override.hasOverride && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="self-start text-xs"
                        onClick={() =>
                          handleChannelOverrideChange(channel.id, {
                            hasOverride: false,
                            content: sharedContent,
                          })
                        }
                      >
                        {t("Remove Custom Override")}
                      </Button>
                    )}
                  </ComposerSection>

                  <ComposerSection
                    icon={ImageIcon}
                    title={t("Attachments for {name}", { name: channel.name })}
                  >
                    <label
                      htmlFor={`channel-media-${channel.id}`}
                      className="flex min-h-12 cursor-pointer items-center justify-between gap-3"
                    >
                      <span className="flex min-w-0 flex-col gap-1">
                        <span
                          id={`channel-media-label-${channel.id}`}
                          className="text-xs font-medium text-ink"
                        >
                          {t("Use post attachments")}
                        </span>
                        <span
                          id={`channel-media-state-${channel.id}`}
                          className="text-(length:--font-size-micro) text-ink-3"
                        >
                          {inheritsAttachments
                            ? t("All post attachments")
                            : includesAttachments
                              ? t("Selected attachments")
                              : t("Text only")}
                        </span>
                      </span>
                      <Switch
                        id={`channel-media-${channel.id}`}
                        aria-labelledby={`channel-media-label-${channel.id}`}
                        aria-describedby={`channel-media-state-${channel.id}`}
                        checked={includesAttachments}
                        onCheckedChange={(checked) =>
                          handleSetChannelAttachments(channel.id, checked ? null : [])
                        }
                      />
                    </label>
                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {attachments.map((attachment, index) => {
                          const assetId = attachment.assetId;
                          if (!assetId) return null;
                          const selected = channelAttachmentAssetIds.has(assetId);
                          return (
                            <Button
                              key={attachment.key}
                              type="button"
                              variant={selected ? "secondary" : "outline"}
                              size="sm"
                              aria-pressed={selected}
                              className="text-xs h-8 gap-1.5 max-w-[12rem]"
                              onClick={() => handleToggleChannelAttachment(channel.id, assetId)}
                            >
                              {selected ? (
                                <Check className="size-3.5 shrink-0" />
                              ) : (
                                <ImageIcon className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate">
                                {index + 1}. {attachment.name}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </ComposerSection>

                  <PlatformSettings
                    provider={channel.providerIdentifier}
                    channelName={channel.name}
                    channelId={channel.id}
                    capability={capabilityByPlatform.get(channel.providerIdentifier.toLowerCase())}
                    settings={settingsForAttachmentOrder(
                      override.settings,
                      channelAttachments.map((attachment) => attachment.assetId ?? attachment.key),
                    )}
                    mediaKinds={channelAttachments.flatMap((attachment) =>
                      attachment.assetType ? [attachment.assetType] : [],
                    )}
                    onChange={(newSettings) =>
                      handleChannelOverrideChange(channel.id, { settings: newSettings })
                    }
                    onRequirementsChange={handleRequirementsChange}
                  />
                </div>
              </section>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-col gap-6 @4xl:-my-1 @4xl:min-h-0 @4xl:w-85 @4xl:shrink-0 @4xl:overflow-y-auto @4xl:border-l @4xl:border-line @4xl:py-1 @4xl:pr-1 @4xl:pl-6">
          <DestinationSelector
            onNavigate={requestNavigate}
            selectedProfileIds={selectedProfileIds}
            onProfilesChange={(ids) => {
              setSelectedProfileIds(ids);
              markDirty();
            }}
          />

          <ComposerSection icon={Send} title={t("Publishing")}>
            <SegmentedControl
              options={PUBLISH_MODES}
              value={publishMode}
              onChange={setPublishMode}
              label={t("Publishing")}
              fill
              className="w-full"
              renderOption={(mode) => {
                const Icon = PUBLISH_MODE_ICONS[mode];
                return (
                  <>
                    <Icon className="size-3.5" />
                    <span>{publishModeOption(mode, t)}</span>
                  </>
                );
              }}
            />

            {publishMode === "schedule" && (
              <ScheduleDateTime
                value={scheduleDate}
                timeZone={publishingTimeZone}
                onChange={(value) => {
                  scheduleTouchedRef.current = true;
                  setScheduleDate(value);
                  markDirty();
                }}
              />
            )}
            {publishMode === "queue" && (
              <div className="space-y-2">
                <Select
                  value={selectedQueue?.id ?? ""}
                  onValueChange={(value) => {
                    setSelectedQueueId(value);
                    markDirty();
                  }}
                >
                  <SelectTrigger
                    aria-label={t("Publishing Queue")}
                    disabled={queueQuery.isPending || selectedProfileIds.length !== 1}
                  >
                    <SelectValue placeholder={t("Choose a Queue")} />
                  </SelectTrigger>
                  <SelectContent>
                    {publishingQueues.map((queue) => (
                      <SelectItem key={queue.id} value={queue.id}>
                        {queue.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedQueue && <p className="text-xs text-ink-3">{selectedQueue.timezone}</p>}
                {queueQuery.error && (
                  <p role="alert" className="text-xs text-destructive">
                    {userFacingErrorMessage(queueQuery.error, language)}
                  </p>
                )}
                {queueQuery.hasNextPage && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void queueQuery.fetchNextPage();
                    }}
                    disabled={queueQuery.isFetchingNextPage}
                  >
                    {t("Load more Queues")}
                  </Button>
                )}
                <Button variant="link" onClick={() => requestNavigate("queues")}>
                  {t("Manage Queues")}
                </Button>
                {postQuery.data?.queue_membership && (
                  <p className="text-xs text-ink-2">
                    {t("Assigned: {time}", {
                      time: new Date(postQuery.data.queue_membership.assigned_at).toLocaleString(
                        language,
                      ),
                    })}
                  </p>
                )}
              </div>
            )}

            <p className="text-(length:--font-size-micro) text-ink-3">
              {publishMode === "draft"
                ? t("Saves this post's text, attachments, and channel settings without publishing")
                : publishMode === "queue"
                  ? t(
                      "Assigns the next free future slot without changing your content or Channel settings.",
                    )
                  : publishMode === "schedule"
                    ? t("Queues this post to {count} channel(s) at the selected time.", {
                        count: selectedChannels.length,
                      })
                    : t("Queues this post to {count} channel(s) right away.", {
                        count: selectedChannels.length,
                      })}
            </p>
          </ComposerSection>
        </div>
      </div>

      <div className="sticky bottom-0 -mx-4 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-4 pb-(--safe-control-bottom) pt-2.5 sm:-mx-6 sm:px-6">
        <p
          className="min-w-0 basis-full text-(length:--font-size-micro) text-ink-3 @sm:basis-0 @sm:flex-1"
          role="status"
        >
          {savedAt && !isDirty
            ? t("Saved to your workspace at {time}", {
                time: new Date(savedAt).toLocaleTimeString(language),
              })
            : isDirty
              ? t("Unsaved changes are kept in this browser until you save.")
              : t("Draft changes are saved to your workspace when you save.")}
        </p>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void handleSubmit(publishMode)}
          disabled={submitDisabled || (publishMode === "schedule" && !scheduleDate)}
          className="h-8 w-full shrink-0 gap-1.5 @sm:w-auto"
          title={
            publishMode === "draft"
              ? t("Saves this post's text, attachments, and channel settings without publishing")
              : providerValidationErrors[0]
          }
        >
          {isSubmitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <PublishModeIcon className="size-3.5" />
          )}
          {selectedProfileIds.length > 1
            ? publishMode === "draft"
              ? t("Save Drafts")
              : publishMode === "schedule"
                ? t("Schedule Posts")
                : t("Publish Posts")
            : publishModeAction(publishMode, postId, t)}
        </Button>
      </div>

      <CenterAlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open && !isSavingBeforeLeave) setPendingNavigation(null);
        }}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>{t("Save this Post before leaving?")}</CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {t(
                "This composition has unsaved changes that cannot be restored after you leave. Save it as a draft, discard it, or keep editing.",
              )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel disabled={isSavingBeforeLeave}>
              {t("Keep editing")}
            </CenterAlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isSavingBeforeLeave}
              onClick={continuePendingNavigation}
            >
              {t("Discard and continue")}
            </Button>
            <Button
              type="button"
              disabled={isSavingBeforeLeave}
              onClick={() => void saveDraftAndContinue()}
            >
              {isSavingBeforeLeave ? t("Saving…") : t("Save draft and continue")}
            </Button>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>
    </fieldset>
  );
}
