import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasCookieConsent,
  readFunctionalStorage,
  subscribeCookieConsent,
  writeFunctionalStorage,
} from "@meltiply/ui/cookie-consent";

import { useWorkspace } from "@/context/workspace.context";
import { DestinationSelector } from "@/components/workspace/destination-selector";
import type { WorkspaceView } from "@/components/layout/navigation-shell";
import { PlatformSettings, providerDescriptorFor, type PostTargetDraft } from "./platform-settings";
import { MediaPreview } from "@/components/media/media-preview";
import { Button } from "@meltiply/ui/button";
import { Textarea } from "@meltiply/ui/textarea";
import { Input } from "@meltiply/ui/input";
import { Badge } from "@meltiply/ui/badge";
import { Alert } from "@meltiply/ui/alert";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@meltiply/ui/tabs";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
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
} from "lucide-react";
import type { ChannelIntegration } from "@/api/types";
import type { Asset, CreatePostInput, Post, TikTokPublishingRequirements } from "@/types";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  useAsset,
  useCreatePost,
  usePlatformCapabilities,
  usePlatforms,
  usePost,
  useSchedulePost,
  useUpdatePost,
} from "@/lib/queries";
import { createAssetUpload, type AssetUploadStatus, type AssetUploadTask } from "@/lib/upload";
import { useI18n } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { userFacingErrorMessage } from "@/lib/frontend-errors";

/**
 * Per-destination overrides for post body content and platform-specific settings.
 * `hasOverride` distinguishes a Channel that inherits the shared `default_text`
 * from one carrying its own caption, which the Post target persists as
 * `description_override` (null means inherit).
 */
interface ChannelOverride {
  content: string;
  hasOverride: boolean;
  settings: Record<string, unknown>;
}

/** Publishing intents the composer submits; the pinned bar acts on the chosen one. */
const PUBLISH_MODES = ["draft", "schedule", "now"] as const;
type PublishMode = (typeof PUBLISH_MODES)[number];

/**
 * Label of one publishing-mode option in the selector. Kept as literal calls so
 * the translation catalog can still see every message statically.
 *
 * @param mode - Publishing intent the option selects.
 * @param t - Active translator.
 * @returns Localized option label.
 */
function publishModeOption(mode: PublishMode, t: (message: string) => string): string {
  switch (mode) {
    case "draft":
      return t("Draft");
    case "schedule":
      return t("Schedule");
    case "now":
      return t("Now");
  }
}

/**
 * Label of the pinned action for a publishing mode: it names the action the
 * button performs rather than repeating the mode's own label.
 *
 * @param mode - Selected publishing intent.
 * @param postId - Existing Post id, which makes a draft submission a plain save.
 * @param t - Active translator.
 * @returns Localized action label.
 */
function publishModeAction(
  mode: PublishMode,
  postId: string | null,
  t: (message: string) => string,
): string {
  if (mode === "draft") return postId === null ? t("Save Draft") : t("Save");
  if (mode === "schedule") return t("Schedule Post");
  return t("Publish Now");
}

/** Icon per publishing mode, matching the action the pinned bar performs. */
const PUBLISH_MODE_ICONS = { draft: Save, schedule: Calendar, now: Send } as const;

/**
 * One composer attachment row: a durable Asset reference plus, while the file
 * is still in the browser, the live upload task driving it.
 *
 * `assetId` is null only until the upload session exists; `uploadStatus` is the
 * local pipeline state (null once the row has no local task), while `assetStatus`
 * mirrors the server-owned `Asset.status` for anything the Post already holds.
 */
interface AttachmentEntry {
  /** Stable React key; also the upload-task map key. */
  key: string;
  /** Durable Asset id, or null while the upload session is still being created. */
  assetId: string | null;
  /** Display name shown under the preview. */
  name: string;
  /** Declared MIME type, used for video detection before the Asset record exists. */
  mimeType: string | null;
  /** Contract asset type once known. */
  assetType: Asset["asset_type"] | null;
  /** Local upload pipeline status; null when the row has no in-browser task. */
  uploadStatus: AssetUploadStatus | null;
  /** Uploaded percentage (0–100) reported by the task. */
  percent: number;
  /** Server-owned Asset status, refreshed by Post polling. */
  assetStatus: Asset["status"] | null;
  /** Actionable failure text from the local task or the Asset record. */
  failureMessage: string | null;
  /** Blob URL for previewing a local file before its Asset is readable. */
  previewUrl: string;
  /** Live task for pause/resume/cancel while uploading. */
  task: AssetUploadTask | null;
  /**
   * True while the browser still holds the local `File`, which is what makes an
   * in-place retry possible after a failure; rows restored from a saved Post do
   * not and therefore offer replace/remove instead.
   */
  hasLocalFile: boolean;
}

/**
 * Where the Channels that had explicitly selected a replaced Asset kept it:
 * `[channelId, position]` pairs captured before the old row was detached, so the
 * replacement takes those selections over instead of dropping them.
 */
type ReplacedSelections = ReadonlyArray<readonly [string, number]>;

/**
 * Browser-local recovery record. It supplements the authoritative server Post
 * so an interrupted session can resume typing, but it is scoped per
 * Workspace/Brand Profile/Post so it can never surface under another identity,
 * and a successful save deletes it.
 */
interface ComposerRecoveryRecord {
  attachmentOverrides: Record<string, string[]>;
  attachments: Array<{
    assetId: string;
    assetType: Asset["asset_type"] | null;
    mimeType: string | null;
    name: string;
  }>;
  channelOverrides: Record<string, ChannelOverride>;
  removedAssetIds: string[];
  scheduleDate: string;
  sharedContent: string;
  updatedAt: string;
  version: 1;
}

/** localStorage namespace for supplemental composer recovery. */
const recoveryKeyPrefix = "meltiply.composer.v1.";

/** Upload statuses whose lifecycle is finished: the file's bytes no longer need it. */
const terminalUploadStatuses: ReadonlySet<AssetUploadStatus> = new Set([
  "cancelled",
  "complete",
  "completing",
  "failed",
  "processing",
]);

/** Upload statuses that still hold the file's bytes: only these may pause/resume. */
const activeUploadStatuses: ReadonlySet<AssetUploadStatus> = new Set([
  "creating",
  "uploading",
  "paused",
  "offline",
]);

/**
 * Type guard distinguishing an intentional upload cancellation from a real
 * failure, so a cancelled file is not reported as an actionable error.
 *
 * @param error - Rejection reason from an upload task.
 * @returns True when the task was cancelled by the creator or by an abort.
 */
function isUploadCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "UploadCancelledError";
}

/**
 * Formats a Date or ISO string into a local HTML datetime-local value
 * ('YYYY-MM-DDTHH:mm'). Midnight on the supplied day becomes 10:00 local so a
 * calendar click offers a realistic daytime slot instead of the past.
 *
 * @param dateOrStr - Date object or ISO timestamp.
 * @returns Local datetime string, or an empty string when the input is unparseable.
 */
function formatInitialScheduleDate(dateOrStr: Date | string): string {
  const date = typeof dateOrStr === "string" ? new Date(dateOrStr) : new Date(dateOrStr.getTime());
  if (Number.isNaN(date.getTime())) return "";
  if (date.getHours() === 0 && date.getMinutes() === 0) date.setHours(10, 0, 0, 0);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Resolves one attachment row to the lifecycle phase the composer reports:
 * `ready` is the only phase that may be published, `failed` blocks the
 * affected Channel with an actionable reason, and everything else is still in
 * flight. Only the byte-transfer statuses (creating/uploading/paused/offline)
 * are local: once the task reports `processing` or `complete` the Asset record
 * is the authority, so the server status and its failure reason decide.
 *
 * @param attachment - The composer attachment row.
 * @param t - Localized translate function.
 * @returns Phase name, its localized label, and any actionable failure text.
 */
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
  // `processing`/`completing`/`complete` deliberately fall through: the Asset
  // record owns every stage after the bytes arrive, including its failure.
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

/**
 * Follows one uploaded Asset's server-side processing while the composition has
 * no Post id yet, so a finished upload still reports Processing until the Asset
 * is verified ready. Once a Post exists its own `usePost` poll already carries
 * attachment state, so this poller stays unmounted to avoid a second request
 * stream for the same data.
 *
 * @param props.assetId - Durable Asset id learned from the upload session.
 * @param props.assetStatus - Status already known for the row; the query stops
 *   enabling itself once the Asset leaves an active state.
 * @param props.onAssetUpdate - Merges a fresher Asset snapshot into the row.
 * @returns Nothing visible; exists only to host the `useAsset` query.
 */
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

/**
 * Rebuilds per-channel composer overrides from a saved Post: provider settings
 * come from the descriptor's `readTarget`, and the caption override is only
 * flagged when it actually differs from the shared default text.
 *
 * A target that has never been scheduled carries no Distribution, so its
 * platform is resolved from the workspace's Channel list and the Distribution
 * stays a fallback for a Channel the list no longer contains. Resolving against
 * an empty list would rebuild every provider panel empty and erase those
 * options on the next save.
 *
 * @param post - The hydrated Post.
 * @param platformByAccountId - Provider identifier per Platform account id.
 * @returns Channel-id keyed override map.
 */
function overridesFromPost(
  post: Post,
  platformByAccountId: Readonly<Record<string, string | undefined>>,
): Record<string, ChannelOverride> {
  const overrides: Record<string, ChannelOverride> = {};
  for (const target of post.targets) {
    const platform =
      platformByAccountId[target.platform_account_id] ??
      post.distributions.find(
        (distribution) => distribution.platform_account_id === target.platform_account_id,
      )?.platform ??
      "";
    const descriptor = providerDescriptorFor(platform);
    const content = target.description_override ?? post.default_text;
    overrides[target.platform_account_id] = {
      content,
      hasOverride:
        target.description_override !== null && target.description_override !== post.default_text,
      settings: descriptor?.readTarget?.(target) ?? {},
    };
  }
  return overrides;
}

/**
 * Extracts per-channel attachment selections from a saved Post. `null`
 * (`inherit`) stays absent from the map; `[]` (text-only) and explicit ordered
 * lists are preserved so a reopened draft publishes what it published before.
 *
 * @param post - The hydrated Post.
 * @returns Channel-id keyed attachment id lists for targets that override them.
 */
function attachmentOverridesFromPost(post: Post): Record<string, string[]> {
  const overrides: Record<string, string[]> = {};
  for (const target of post.targets) {
    if (target.attachment_ids !== null)
      overrides[target.platform_account_id] = [...target.attachment_ids];
  }
  return overrides;
}

/**
 * Rebuilds composer rows from a recovery record. The record's Asset order is
 * the creator's unsaved order, an Asset the creator detached is never restored,
 * and rows the record cannot name — an upload that has not learned a durable
 * Asset id yet, or a row the server owns that this record predates — keep their
 * own rows after the restored ones, so applying recovery never drops a row.
 *
 * @param previous - Rows currently in the composer.
 * @param record - Recovery record being applied.
 * @param removedAssetIds - Asset ids the creator detached before the record was written.
 * @returns Rows reordered to the record and stripped of detached Assets.
 */
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

/**
 * Multi-Channel Post composer: shared text, composer-owned media uploads with
 * ordered attachments, per-Channel captions/options/attachment selections, and
 * authoritative save/schedule/publish against one stable Post identity.
 *
 * Saving writes the same Post every time — `useCreatePost` only for the first
 * save of a new composition, `useUpdatePost` afterwards — so text, ordered
 * `attachment_ids`, and saved targets form one persisted record. No server Post
 * is created merely by opening the composer.
 *
 * Uploads run through `createAssetUpload` directly (file picker or drag and
 * drop), so per-file progress, processing state, pause/resume, cancel, and retry
 * live here instead of in the retired media library. When an upload session
 * starts while editing an already-saved Post, the new Asset id is persisted as
 * an attachment immediately so a draft never drops a still-uploading file.
 *
 * Scheduling/publishing goes through `useSchedulePost`, which validates every
 * affected Channel and rewrites only editable pending Distributions; published
 * outcomes are never rewritten by editing.
 *
 * Browser-local recovery supplements (never replaces) the server Post only
 * after functional consent. It is namespaced by Workspace/Brand Profile/Post,
 * cleared on a successful save or consent withdrawal, and can never surface an
 * upload under another profile. Recovery is read before persistence opens, so a
 * reload restores unsaved work instead of replacing it with an empty first frame.
 *
 * Invariant: no failed action clears creator input, and a saved indication is
 * only shown after the server acknowledged the save.
 *
 * @param props.initialPostId - Optional stable Post UUID to hydrate and edit.
 * @param props.initialDate - Optional Date or ISO string pre-populating the schedule slot.
 * @param props.onPostSuccess - Callback executed after a successful schedule/publish.
 * @param props.onNavigate - Callback to navigate to another workspace view.
 */
export interface ComposerProps {
  initialPostId?: string;
  initialDate?: Date | string;
  onPostSuccess?: () => void;
  onNavigate?: (view: WorkspaceView, options?: { search?: string }) => void;
}

/**
 * Renders the composer with one authoritative Post as its state boundary.
 * Controls remain disabled until server hydration and browser recovery settle,
 * so their deferred restores cannot overwrite a creator's first edit or save.
 *
 * @param props - Deep-link Post id, optional schedule seed, and navigation callbacks.
 * @returns The Post composer surface.
 */
export function Composer({ initialPostId, initialDate, onPostSuccess, onNavigate }: ComposerProps) {
  const {
    brandProfiles,
    integrations,
    selectedChannelIds,
    selectedBrandProfileId,
    setSelectedChannelIds,
    refreshWorkspace,
  } = useWorkspace();
  const scope = useSessionScope();
  const { t, tStatus, language } = useI18n();

  // The deep link is the Post identity; a composition that has not been saved yet
  // has none, so the id only appears once the first save returns it.
  const [createdPostId, setCreatedPostId] = useState<string | null>(null);
  const postId = initialPostId ?? createdPostId;
  const [sharedContent, setSharedContent] = useState("");
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [channelOverrides, setChannelOverrides] = useState<Record<string, ChannelOverride>>({});
  const [attachmentOverrides, setAttachmentOverrides] = useState<Record<string, string[]>>({});
  const [activeTab, setActiveTab] = useState<string>("shared");
  /**
   * Publishing intent the composer submits: a calendar entry point seeds
   * `schedule` so the seeded slot is editable on arrival, and everything else
   * starts on the non-destructive draft mode.
   */
  const [publishMode, setPublishMode] = useState<PublishMode>(
    initialDate !== undefined ? "schedule" : "draft",
  );
  const [scheduleDate, setScheduleDate] = useState<string>(() => {
    const seeded = initialDate ? formatInitialScheduleDate(initialDate) : "";
    if (seeded) return seeded;
    const fallback = new Date(Date.now() + 1000 * 60 * 60 * 2);
    fallback.setMinutes(fallback.getMinutes() - fallback.getTimezoneOffset());
    return fallback.toISOString().slice(0, 16);
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [hydratedPostId, setHydratedPostId] = useState<string | null>(null);
  // Recovery is neither read nor written until functional consent is active.
  const [functionalConsent, setFunctionalConsent] = useState(() => hasCookieConsent("functional"));
  const [recoveryReadNamespace, setRecoveryReadNamespace] = useState<string | null>(null);
  const [tiktokRequirements, setTiktokRequirements] = useState<
    Record<string, TikTokPublishingRequirements | null>
  >({});
  const [pendingOwnershipAssetIds, setPendingOwnershipAssetIds] = useState<string[] | null>(null);
  const [isDragActive, setDragActive] = useState(false);

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

  // Identity of the composition the creator is working on. Switching it (another
  // Brand Profile or another deep-linked Post) abandons the current rows; a first
  // save only fills in `postId`, which moves the recovery namespace but not this
  // identity, so saving a draft never discards the work in front of the creator.
  const composerIdentity = `${scope.workspaceId ?? "personal"}::${selectedBrandProfileId ?? "all"}::${initialPostId ?? "new"}`;
  const recoveryNamespace = `${scope.workspaceId ?? "personal"}::${selectedBrandProfileId ?? "all"}::${postId ?? "new"}`;
  // Async upload callbacks need the *current* identity without re-subscribing,
  // so the refs are synced after commit rather than during render.
  useEffect(() => {
    recoveryNamespaceRef.current = recoveryNamespace;
    composerIdentityRef.current = composerIdentity;
    postIdRef.current = postId;
  }, [composerIdentity, postId, recoveryNamespace]);
  // Consent can change while the composer is open; keep recovery reads and
  // writes closed until the current page has an explicit functional choice.
  useEffect(
    () =>
      subscribeCookieConsent(() => {
        setFunctionalConsent(hasCookieConsent("functional"));
      }),
    [],
  );

  const postQuery = usePost(scope, postId ?? "", postId !== null);
  const capabilitiesQuery = usePlatformCapabilities(scope);
  const createPost = useCreatePost(scope);
  const updatePost = useUpdatePost(scope);
  const schedulePost = useSchedulePost(scope);

  // A saved target that has never been scheduled names no platform of its own,
  // so the Channel list is where its provider settings are resolved from. The
  // workspace provider already runs this exact query; subscribing here shares
  // its cache entry (no second request) purely for its settledness, so
  // hydration cannot race the Channel list it depends on.
  const platformsQuery = usePlatforms(scope, { brandProfileId: null });
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

  // Mirrors the committed per-Channel selections so an event handler can read
  // where a detaching Asset sat without running logic inside a state updater.
  useEffect(() => {
    attachmentOverridesRef.current = attachmentOverrides;
  }, [attachmentOverrides]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    const tasks = tasksRef.current;
    const files = filesRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      for (const task of tasks.values()) void task.cancel();
      tasks.clear();
      files.clear();
    };
  }, []);

  // Seed the schedule slot from a calendar click unless an existing Post is open.
  const [prevInitialDate, setPrevInitialDate] = useState(initialDate);
  if (initialDate !== prevInitialDate) {
    setPrevInitialDate(initialDate);
    if (initialDate && !initialPostId) setScheduleDate(formatInitialScheduleDate(initialDate));
  }

  /**
   * Returns every composer row to its empty state for a new Post. Runs when the
   * deep-linked identity changes and after a successful schedule/publish, so the
   * composer never shows another Post's content under a new Post id.
   *
   * @returns Nothing; performs the state resets.
   */
  const resetComposer = useCallback(() => {
    setSharedContent("");
    setAttachments([]);
    setChannelOverrides({});
    setAttachmentOverrides({});
    setSelectedChannelIds([]);
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

  // Opening a different Post or switching Brand Profile abandons in-flight
  // composer state so nothing from the previous identity can leak into it —
  // including the upload tasks the detached rows still own; without the abort
  // their callbacks keep running (guarded off by composerIdentityRef) and the
  // ref's stale value would make every later switch a no-op. This runs before
  // the hydration and recovery effects below, so the new identity's
  // authoritative state is what lands last.
  const cancelledIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (cancelledIdentityRef.current === null) {
      // First commit: there is no previous identity to abandon.
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

  /**
   * Reads the supplemental browser-local record for the active identity only
   * after functional consent; unavailable or invalid data yields null.
   */
  const readRecovery = useCallback((): ComposerRecoveryRecord | null => {
    try {
      const raw = readFunctionalStorage(recoveryKeyPrefix + recoveryNamespaceRef.current);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Partial<ComposerRecoveryRecord>;
      // Every field is applied unconditionally on restore, so a record missing
      // any of them is treated as unrecoverable rather than half-applied.
      return record.version === 1 &&
        typeof record.updatedAt === "string" &&
        typeof record.sharedContent === "string" &&
        typeof record.scheduleDate === "string" &&
        Array.isArray(record.attachments) &&
        Array.isArray(record.removedAssetIds) &&
        typeof record.channelOverrides === "object" &&
        record.channelOverrides !== null &&
        typeof record.attachmentOverrides === "object" &&
        record.attachmentOverrides !== null
        ? (record as ComposerRecoveryRecord)
        : null;
    } catch {
      return null;
    }
  }, []);

  /**
   * Writes or deletes the supplemental browser-local record only when
   * functional consent allows it; deletion remains available after withdrawal.
   */
  const writeRecovery = useCallback((record: ComposerRecoveryRecord | null) => {
    try {
      const key = recoveryKeyPrefix + recoveryNamespaceRef.current;
      writeFunctionalStorage(key, record ? JSON.stringify(record) : null);
    } catch {
      // Storage may be disabled or full; the server Post remains authoritative.
    }
  }, []);

  /**
   * Deletes every supplemental record a successful save supersedes: both the
   * namespace active when the save began and the one the saved Post id moves to.
   * Either copy could restore work the server now owns, including into the empty
   * composer after a publish. Removal remains permitted after consent withdrawal.
   *
   * @param namespaceAtSubmit - Recovery namespace active when the save started.
   */
  const clearRecoveryAfterSave = useCallback((namespaceAtSubmit: string) => {
    for (const namespace of new Set([namespaceAtSubmit, recoveryNamespaceRef.current])) {
      writeFunctionalStorage(recoveryKeyPrefix + namespace, null);
    }
  }, []);

  // Persist unsaved work only after functional consent and after the active
  // namespace has been read. Records hold durable Asset ids only; uploads with
  // no server session cannot resume after reload because the File handle is gone.
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
      updatedAt: new Date().toISOString(),
      version: 1,
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
    writeRecovery,
  ]);

  // Hydrate shared text, Channel selection, per-channel settings, attachment
  // selection, and schedule slot from the authoritative Post exactly once per
  // identity, so later polling never overwrites creator input.
  useEffect(() => {
    const post = postQuery.data;
    if (!post || !postId || hydratedPostId === postId) return;
    // Provider settings are rebuilt per saved target, and a draft that has never
    // been scheduled names no platform of its own, so hydration waits for the
    // Channel list instead of rebuilding every provider panel empty.
    if (platformsQuery.isPending) return;
    const channelIds = new Set<string>(post.targets.map((target) => target.platform_account_id));
    for (const distribution of post.distributions) {
      if (distribution.platform_account_id) channelIds.add(distribution.platform_account_id);
    }
    const scheduledAt = post.distributions
      .map((distribution) => distribution.scheduled_at)
      .find((value): value is string => Boolean(value));
    // The rows are adopted in a deferred callback (the pattern this composer used
    // before the cutover) so hydration never interrupts the commit that first
    // rendered the loading state.
    const timer = window.setTimeout(() => {
      setHydratedPostId(postId);
      setSharedContent(post.default_text);
      setChannelOverrides(overridesFromPost(post, platformByAccountId));
      setAttachmentOverrides(attachmentOverridesFromPost(post));
      setSelectedChannelIds([...channelIds]);
      if (scheduledAt) setScheduleDate(formatInitialScheduleDate(scheduledAt));
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
    setSelectedChannelIds,
  ]);

  // Read and apply the browser-local record only after functional consent, and
  // only when it is newer than the server Post it would overwrite: a reloaded
  // tab restores unsaved content and attachments, while a saved Post wins.
  useEffect(() => {
    if (!functionalConsent || recoveryReadNamespace === recoveryNamespace) return;
    if (postId && (!postQuery.data || hydratedPostId !== postId)) return;
    const record = readRecovery();
    // A record only wins when it is newer than the server Post it would
    // overwrite: a freshly saved Post keeps the authority it already holds.
    const shouldRestore =
      record !== null &&
      (!postQuery.data || Date.parse(record.updatedAt) > Date.parse(postQuery.data.updated_at));
    // The restore — and the opening of the persistence gate — land in a
    // deferred callback so hydration commits first, and the namespace is only
    // marked read once the callback ran: a StrictMode remount or dep change
    // that clears the timer re-reads the record instead of losing it.
    const timer = window.setTimeout(() => {
      if (record && shouldRestore) {
        const removedAssetIds = new Set(record.removedAssetIds);
        removedAssetIdsRef.current = removedAssetIds;
        setAttachments((previous) => restoredAttachmentRows(previous, record, removedAssetIds));
        setSharedContent(record.sharedContent);
        setChannelOverrides(record.channelOverrides);
        setAttachmentOverrides(record.attachmentOverrides);
        if (record.scheduleDate) setScheduleDate(record.scheduleDate);
        // Restored work is unsaved: it is reported as such and can be saved
        // over the server Post the creator was editing.
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
  ]);

  // Merge server-owned attachment state into composer rows. Locally removed
  // Assets and locally diverged ordering are never re-added: the creator's
  // in-progress edit stays authoritative until the next save.
  useEffect(() => {
    const post = postQuery.data;
    if (!post) return;
    setAttachments((previous) => {
      let changed = false;
      const next = previous.map((entry) => {
        if (!entry.assetId) return entry;
        const remote = post.attachments.find((item) => item.asset_id === entry.assetId);
        if (!remote) return entry;
        const merged: AttachmentEntry = {
          ...entry,
          assetStatus: remote.asset.status,
          assetType: remote.asset.asset_type,
          failureMessage: remote.asset.failure?.message ?? entry.failureMessage,
          mimeType: remote.asset.mime_type ?? entry.mimeType,
          name: remote.asset.title || entry.name,
          percent: remote.asset.status === "failed" ? entry.percent : 100,
        };
        if (
          merged.assetStatus !== entry.assetStatus ||
          merged.failureMessage !== entry.failureMessage ||
          merged.name !== entry.name ||
          merged.assetType !== entry.assetType
        ) {
          changed = true;
        }
        return changed ? merged : entry;
      });
      for (const remote of post.attachments) {
        if (removedAssetIdsRef.current.has(remote.asset_id)) continue;
        if (next.some((entry) => entry.assetId === remote.asset_id)) continue;
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
  }, [postQuery.data]);

  /**
   * Merges a fresh Asset snapshot into its composer row, used by the per-asset
   * processing poller while the composition has no Post id. Mirrors the merge
   * rules of the Post-driven effect above but never adds or reorders rows.
   *
   * @param asset - Latest Asset record for the row's durable id.
   */
  const handleAssetUpdate = useCallback((asset: Asset) => {
    setAttachments((previous) =>
      previous.map((entry) => {
        if (entry.assetId !== asset.id) return entry;
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
      }),
    );
  }, []);

  const orderedAssetIds = useCallback(
    () =>
      attachments.map((attachment) => attachment.assetId).filter((id): id is string => Boolean(id)),
    [attachments],
  );
  // A saved Post must retain ownership of an upload whose Asset id only became
  // known after the save, otherwise the Asset would look orphaned and the draft
  // would silently lose the file.
  useEffect(() => {
    const assetIds = pendingOwnershipAssetIds;
    if (!postId || !assetIds || assetIds.length === 0) return;
    const profileId = selectedBrandProfileId;
    if (profileId === null) return;
    // Ids already handed to a PATCH are not resent; the effect re-runs when the
    // ordered rows change so a freshly known id still lands in the same patch.
    // An Asset the creator detached never reaches the Post, even when its id was
    // learned moments before the row was removed.
    const fresh = assetIds.filter(
      (assetId) =>
        !persistedOwnershipRef.current.has(assetId) && !removedAssetIdsRef.current.has(assetId),
    );
    if (fresh.length === 0) return;
    for (const assetId of fresh) persistedOwnershipRef.current.add(assetId);
    const attachmentIds = [...orderedAssetIds()];
    for (const assetId of fresh) if (!attachmentIds.includes(assetId)) attachmentIds.push(assetId);
    void updatePost
      .mutateAsync({
        id: postId,
        input: { brand_profile_id: profileId, attachment_ids: attachmentIds },
      })
      .catch(() => {
        // Ownership is retried on the next explicit save; never claim it is saved.
      });
  }, [orderedAssetIds, pendingOwnershipAssetIds, postId, selectedBrandProfileId, updatePost]);

  const selectedChannels = useMemo(
    () =>
      integrations.filter(
        (channel: ChannelIntegration) =>
          channel.brandProfileId === selectedBrandProfileId &&
          selectedChannelIds.includes(channel.id),
      ),
    [integrations, selectedBrandProfileId, selectedChannelIds],
  );

  /**
   * Receives live TikTok publishing requirements from a Channel's settings panel
   * and records them for submit-time validation.
   *
   * @param channelId - Platform account id the requirements belong to.
   * @param requirements - Live requirements, or null when unavailable.
   */
  const handleRequirementsChange = useCallback(
    (channelId: string, requirements: TikTokPublishingRequirements | null) => {
      setTiktokRequirements((previous) =>
        previous[channelId] === requirements
          ? previous
          : { ...previous, [channelId]: requirements },
      );
    },
    [],
  );

  /**
   * Resolves the effective caption for a Channel: its custom override when
   * enabled, otherwise the shared composer text.
   *
   * @param channelId - Target Channel id.
   * @returns Caption text for that Channel.
   */
  const resolvedContentFor = useCallback(
    (channelId: string): string =>
      channelOverrides[channelId]?.hasOverride
        ? (channelOverrides[channelId]?.content ?? "")
        : sharedContent,
    [channelOverrides, sharedContent],
  );

  /**
   * Resolves which attachments a Channel publishes: its own ordered selection
   * when set, otherwise the Post's ordered attachments (inherit).
   *
   * @param channelId - Target Channel id.
   * @returns Ordered attachment rows for that Channel.
   */
  const attachmentsForChannel = useCallback(
    (channelId: string): AttachmentEntry[] => {
      const override = attachmentOverrides[channelId];
      if (!override) return attachments;
      return override
        .map((assetId) => attachments.find((attachment) => attachment.assetId === assetId))
        .filter((attachment): attachment is AttachmentEntry => Boolean(attachment));
    },
    [attachmentOverrides, attachments],
  );

  /**
   * Builds the saved Post targets for the current Channel selection, mapping
   * provider settings through the descriptor boundary and recording per-channel
   * caption and attachment overrides. `attachment_ids` is omitted when the
   * Channel inherits the Post's attachments.
   *
   * @returns One Post target input per selected Channel.
   */
  const buildTargets = useCallback((): PostTargetDraft[] => {
    return selectedChannels.map((channel) => {
      const override = channelOverrides[channel.id];
      const target: PostTargetDraft = { platform_account_id: channel.id };
      providerDescriptorFor(channel.providerIdentifier)?.applyTarget?.(
        target,
        override?.settings ?? {},
      );
      // `null` means "inherit the shared caption"; an enabled override stays a
      // string even when blank, because a blank caption is a real choice that
      // `null` would silently turn back into the shared text on the next save.
      target.description_override = override?.hasOverride ? override.content : null;
      const attachmentIds = attachmentOverrides[channel.id];
      if (attachmentIds) target.attachment_ids = [...attachmentIds];
      return target;
    });
  }, [attachmentOverrides, channelOverrides, selectedChannels]);

  /**
   * Merges partial override updates (custom caption, override enablement, or
   * provider settings) for one Channel.
   *
   * @param channelId - Target Channel id.
   * @param updates - Partial override fields to merge.
   */
  const handleChannelOverrideChange = useCallback(
    (channelId: string, updates: Partial<ChannelOverride>) => {
      setChannelOverrides((previous) => ({
        ...previous,
        [channelId]: {
          content: previous[channelId]?.content ?? sharedContent,
          hasOverride: previous[channelId]?.hasOverride ?? false,
          settings: previous[channelId]?.settings ?? {},
          ...updates,
        },
      }));
      markDirty();
    },
    [markDirty, sharedContent],
  );

  /**
   * Starts the composer-owned upload pipeline for one local file.
   *
   * Uploads run only while the identity that started them is still active, so a
   * Brand Profile switch can never attach a file to another profile's Post.
   * `onSessionStart` records the durable Asset id, which both enables saving a
   * draft mid-upload and persists ownership on an already-saved Post.
   *
   * @param file - Local image/video selected by the creator.
   * @param key - Stable row key created by the caller.
   * @param index - Ordered position the new row takes, or null to append.
   * @param replaced - Channel selections the row this upload replaces carried;
   *   the new Asset takes them over as soon as its id is known.
   */
  const startUpload = useCallback(
    (file: File, key: string, index: number | null, replaced: ReplacedSelections | null) => {
      const brandProfileId = selectedBrandProfileId;
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

      /**
       * Moves the Channels that had selected the replaced Asset onto the new
       * Asset id at the same position, leaving every other selection — and any
       * Channel that has since gone back to inheriting — untouched.
       *
       * @param newAssetId - Durable id the replacement upload just learned.
       */
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
    [language, markDirty, scope.isSignedIn, scope.workspaceId, selectedBrandProfileId],
  );

  /**
   * Detaches one attachment row from the composition: its in-flight task is
   * cancelled, the browser blob backing its preview is released, and the local
   * File handle is dropped, so an abandoned row leaves no live transfer, no
   * retained bytes, and no retry target behind.
   *
   * @param target - Row being removed, replaced, or retried.
   * @returns The row's durable Asset id when it already had one, else null.
   */
  const detachAttachmentRow = useCallback((target: AttachmentEntry): string | null => {
    const task = target.task ?? tasksRef.current.get(target.key);
    tasksRef.current.delete(target.key);
    filesRef.current.delete(target.key);
    if (task) void task.cancel();
    if (target.previewUrl) {
      // Revoke before forgetting the handle: dropping the tracked URL without
      // revoking keeps the file's bytes alive for the life of the document.
      URL.revokeObjectURL(target.previewUrl);
      objectUrlsRef.current.delete(target.previewUrl);
    }
    setAttachments((previous) => previous.filter((entry) => entry.key !== target.key));
    return target.assetId;
  }, []);

  /**
   * Records that an Asset left the composition: it is blocked from being
   * re-adopted from server state, dropped from the queue of ids whose ownership
   * still has to reach the Post, and pruned from every Channel's explicit
   * selection so no saved target keeps naming a detached Asset.
   *
   * @param assetId - Durable Asset id that left, when the row had one.
   * @returns Where each Channel had selected it, so a replacement can take over.
   */
  const forgetDetachedAsset = useCallback((assetId: string | null): ReplacedSelections => {
    if (!assetId) return [];
    removedAssetIdsRef.current.add(assetId);
    // An id whose ownership PATCH has not gone out yet must never reach it.
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

  /**
   * Swaps one existing row for a freshly chosen file at exactly the position it
   * occupied: the old row leaves the composition first, so the attachment count
   * and order stay exact instead of growing by one, and the Channels that had
   * selected the old Asset move onto the new one once its id is known.
   *
   * @param file - Local image/video chosen for the row.
   * @param key - Stable row key for the new upload.
   * @param index - Position the outgoing row occupied.
   */
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

  /**
   * Adopts files chosen through the hidden file input, either appending them or
   * replacing the row the creator targeted. A replacement is a swap rather than
   * an insert: the targeted row is detached before the new file takes its
   * position, so caption, ordering, and Channel settings survive the media swap.
   *
   * @param event - Change event from the hidden file input.
   */
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
        const key = `upload-${Date.now()}-${offset}-${file.size}-${file.name}`;
        // Only the first chosen file takes the targeted row's place; the rest
        // follow it, so a multi-file swap never leaves the old row behind.
        if (offset === 0 && index >= 0) {
          replaceAttachmentRow(file, key, index);
          return;
        }
        startUpload(file, key, index >= 0 ? index + offset : null, null);
      });
    },
    [replaceAttachmentRow, startUpload],
  );

  /**
   * Starts uploads for files dropped onto the attachment area.
   *
   * @param event - Drag event carrying the dropped files.
   */
  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      const brandProfileId = selectedBrandProfileId;
      if (!scope.isSignedIn || brandProfileId === null) {
        toast(t("Upload failed"), {
          variant: "error",
          description: t("Select a Brand Profile before uploading media."),
        });
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      files.forEach((file, offset) => {
        const key = `upload-${Date.now()}-${offset}-${file.size}-${file.name}`;
        startUpload(file, key, null, null);
      });
    },
    [scope.isSignedIn, selectedBrandProfileId, startUpload, t],
  );

  /**
   * Removes one attachment while keeping the caption and every Channel's
   * settings intact. A row whose upload is still in flight is cancelled as
   * well, which reclaims its session server-side so the abandoned file stops
   * consuming upload and storage resources. Removed Assets stay referenced
   * until the next save.
   *
   * @param key - Row key to remove.
   */
  const handleRemoveAttachment = useCallback(
    (key: string) => {
      const target = attachmentsRef.current.find((attachment) => attachment.key === key);
      if (!target) return;
      forgetDetachedAsset(detachAttachmentRow(target));
      markDirty();
    },
    [detachAttachmentRow, forgetDetachedAsset, markDirty],
  );

  /**
   * Moves an attachment one position earlier or later in the published order.
   *
   * @param index - Current ordered position of the attachment.
   * @param delta - -1 to move earlier, +1 to move later.
   */
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

  /**
   * Re-runs a failed upload with the same local file, keeping the row and its
   * position so ordering and Channel settings survive the retry.
   *
   * @param key - Row key of the failed upload.
   */
  const handleRetryUpload = useCallback(
    (key: string) => {
      const file = filesRef.current.get(key);
      const index = attachmentsRef.current.findIndex((attachment) => attachment.key === key);
      if (!file || index < 0) return;
      replaceAttachmentRow(file, `upload-retry-${Date.now()}-${key}`, index);
    },
    [replaceAttachmentRow],
  );

  /**
   * Toggles one attachment's membership in a Channel's own selection, or
   * restores the full ordered set when the Channel was inheriting.
   *
   * @param channelId - Target Channel id.
   * @param assetId - Attachment the creator toggled.
   */
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

  /**
   * Sets a Channel's attachment selection explicitly.
   *
   * @param channelId - Target Channel id.
   * @param attachmentIds - Ordered selection, or null to inherit the Post's order.
   */
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

  /**
   * Validates composer state against the Post contract and live Platform
   * capabilities before any mutation runs.
   *
   * Publish modes additionally require publishable media: count bounds (minimum
   * and maximum media constraints per Channel), multi-attachment combinations,
   * permitted asset kinds, and upload/processing readiness are validated per
   * target so an Asset still uploading or processing blocks scheduling for that
   * Channel instead of sending an unverified file. All messages are per Channel
   * so a rejected target never forces changes to the shared Post.
   *
   * Capability-gated checks only run once the capability list has arrived:
   * while it is still in flight the submission is refused with a retry hint,
   * because letting it through would bypass every local rule and surface the
   * API's masked generic error for violations the composer could have named.
   *
   * @param type - Submission mode: `'draft'`, `'schedule'`, or `'now'`.
   * @returns Localized violation messages; empty when submission may proceed.
   */
  const validateSubmission = useCallback(
    (type: "draft" | "schedule" | "now"): string[] => {
      const errors: string[] = [];
      const capabilities = capabilitiesQuery.data;
      const starting = attachments.filter((attachment) => attachment.assetId === null);

      if (selectedBrandProfileId === null) {
        errors.push(t("Select a Brand Profile before publishing."));
      }
      if (type !== "draft" && selectedChannels.length === 0) {
        errors.push(t("Please select at least one destination channel."));
      }
      if (!sharedContent.trim() && attachments.length === 0) {
        errors.push(t("Post must contain text content or at least one media item."));
      }
      if (starting.length > 0) {
        errors.push(
          t("Wait for {count} attachment(s) to finish starting their upload, or remove them.", {
            count: starting.length,
          }),
        );
      }
      if (type === "schedule" && Number.isNaN(new Date(scheduleDate).getTime())) {
        errors.push(t("Please provide a valid schedule date and time."));
      }
      if (type === "draft") return errors;

      if (capabilitiesQuery.isPending) {
        errors.push(t("Platform publishing limits are still loading; try again in a moment."));
      }

      for (const channel of selectedChannels) {
        const name = channel.name;
        const platform = channel.providerIdentifier.toLowerCase();
        const settings = channelOverrides[channel.id]?.settings ?? {};
        const content = resolvedContentFor(channel.id);
        const capability = capabilities?.find((item) => item.platform === platform);
        const channelAttachments = attachmentsForChannel(channel.id);

        if (!content.trim() && channelAttachments.length === 0) {
          errors.push(t("{name}: post text is empty for this channel.", { name }));
        }
        const maxCaption = capability?.max_caption_length;
        if (maxCaption !== null && maxCaption !== undefined && content.length > maxCaption) {
          errors.push(
            t("{name}: text exceeds the {limit}-character limit for this platform.", {
              name,
              limit: maxCaption,
            }),
          );
        }
        if (
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
        if (channelAttachments.length > 1 && capability) {
          const combined = capability.multi_asset_types ?? [];
          if (combined.length === 0) {
            errors.push(t("{name}: cannot publish more than one attachment per post.", { name }));
          } else {
            const hasUnsupported = channelAttachments.some(
              (attachment) => attachment.assetType && !combined.includes(attachment.assetType),
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
            capability.asset_types.length > 0 &&
            !capability.asset_types.includes(assetType)
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

        const descriptor = providerDescriptorFor(channel.providerIdentifier);
        if (descriptor?.validate) {
          errors.push(
            ...descriptor.validate({
              channelName: name,
              settings,
              capability,
              requirements: tiktokRequirements[channel.id] ?? null,
              t,
            }),
          );
        }
      }
      return errors;
    },
    [
      attachments,
      attachmentsForChannel,
      capabilitiesQuery.data,
      capabilitiesQuery.isPending,
      channelOverrides,
      resolvedContentFor,
      scheduleDate,
      selectedBrandProfileId,
      selectedChannels,
      sharedContent,
      t,
      tiktokRequirements,
    ],
  );

  /**
   * Persists the current composer state as one authoritative Post, creating it on
   * first save and updating the same Post afterwards.
   *
   * @param brandProfileId - Scoped Brand Profile that owns the Post.
   * @returns The saved Post as returned by the API.
   */
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

  /**
   * Validates composer state, then saves the Post and — for publish modes —
   * schedules or publishes it against the selected Channels.
   *
   * On success the composer clears its local recovery and reports durable saved
   * state; on any failure every input, attachment, and Channel setting is kept
   * so no creator work is lost and no saved state is claimed. When the API
   * rejects with structured per-field violations (`Error.details`), those
   * messages are shown verbatim in the fix-list alert instead of the masked
   * generic error, so a server-side rule the local checks cannot observe still
   * names its constraint.
   *
   * @param type - Submission mode: `'draft'`, `'schedule'`, or `'now'`.
   */
  const handleSubmit = useCallback(
    async (type: "draft" | "schedule" | "now") => {
      setErrorMessage(null);
      const errors = validateSubmission(type);
      setValidationErrors(errors);
      if (errors.length > 0) return;
      // validateSubmission already reported the aggregate view as an error, so a
      // null selection cannot reach the scoped mutations.
      if (selectedBrandProfileId === null) return;
      const brandProfileId = selectedBrandProfileId;
      // A first save moves the composition from the unsaved `new` namespace to
      // the saved Post's, so both copies have to be captured before the id lands.
      const recoveryNamespaceAtSubmit = recoveryNamespaceRef.current;

      setIsSubmitting(true);
      try {
        const saved = await persistPost(brandProfileId);
        setCreatedPostId(saved.id);
        dirtyRef.current = false;
        removedAssetIdsRef.current = new Set();
        setSavedAt(saved.updated_at);
        setIsDirty(false);
        // The local rows already equal what was just persisted, so the Post is
        // treated as hydrated: a later poll must not overwrite post-save edits.
        setHydratedPostId(saved.id);

        if (type === "draft") {
          clearRecoveryAfterSave(recoveryNamespaceAtSubmit);
          await refreshWorkspace();
          toast(t("Draft saved"), {
            variant: "success",
            description: t("Your post text, attachments, and channel settings are stored."),
          });
          return;
        }

        await schedulePost.mutateAsync({
          id: saved.id,
          input: {
            brand_profile_id: brandProfileId,
            scheduled_at: type === "schedule" ? new Date(scheduleDate).toISOString() : null,
            targets: buildTargets(),
          },
        });
        clearRecoveryAfterSave(recoveryNamespaceAtSubmit);
        setCreatedPostId(null);
        resetComposer();
        toast(type === "now" ? t("Post published") : t("Post scheduled"), {
          variant: "success",
          description:
            type === "now"
              ? t("Distribution to {count} channel(s) has been queued.", {
                  count: selectedChannels.length,
                })
              : t("Distribution to {count} channel(s) is scheduled.", {
                  count: selectedChannels.length,
                }),
        });
        await refreshWorkspace();
        onPostSuccess?.();
      } catch (error) {
        // A rejected mutation that carried structured per-field violations names
        // each one in the fix-list; anything else falls back to the masked
        // user-facing message so internals never surface.
        const details =
          error instanceof ApiError
            ? error.details
                .map((detail) => detail.message)
                .filter((message): message is string => Boolean(message))
            : [];
        if (details.length > 0) setValidationErrors(details);
        else setErrorMessage(userFacingErrorMessage(error, language));
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
      scheduleDate,
      schedulePost,
      selectedBrandProfileId,
      selectedChannels.length,
      t,
      validateSubmission,
    ],
  );

  const postLoadError = postQuery.error;
  const isPostLoading = postId !== null && !postQuery.data && !postLoadError;
  const profileMismatch =
    postQuery.data !== undefined &&
    selectedBrandProfileId !== null &&
    postQuery.data.brand_profile_id !== selectedBrandProfileId;
  // Recovery is optional consent-gated storage: without functional consent the
  // read effect never opens and the namespace stays unread, so that gate only
  // blocks initialization while consent is active (including when consent
  // arrives later and the read settles before persistence).
  const isInitializing =
    !postLoadError &&
    (isPostLoading ||
      (postId !== null && hydratedPostId !== postId) ||
      (functionalConsent && recoveryReadNamespace !== recoveryNamespace));
  /** Icon of the selected publishing mode, shown on the pinned action. */
  const PublishModeIcon = PUBLISH_MODE_ICONS[publishMode];
  const submitDisabled =
    isSubmitting ||
    isInitializing ||
    Boolean(postLoadError) ||
    !scope.isSignedIn ||
    selectedBrandProfileId === null ||
    profileMismatch;

  return (
    <fieldset
      disabled={isInitializing}
      aria-busy={isInitializing}
      className="flex min-w-0 shrink-0 grow flex-col gap-6"
    >
      {selectedBrandProfileId === null && (
        <Alert variant="info" className="items-center">
          <AlertCircle className="size-5 shrink-0" />
          <div className="flex-1">
            {t("Select a Brand Profile in the sidebar to compose, schedule, or publish.")}
          </div>
        </Alert>
      )}
      {profileMismatch && (
        <Alert variant="destructive" className="items-center">
          <AlertCircle className="size-5 shrink-0" />
          <div className="flex-1">
            {t("This post belongs to {name}. Switch to that Brand Profile to edit it.", {
              name:
                brandProfiles.find((profile) => profile.id === postQuery.data?.brand_profile_id)
                  ?.name ?? t("another Brand Profile"),
            })}
          </div>
        </Alert>
      )}
      {postLoadError && (
        <Alert variant="destructive" className="items-center">
          <AlertCircle className="size-5 shrink-0" />
          <div className="flex-1">
            <span className="font-semibold">{t("Could not load post")}:</span>{" "}
            {userFacingErrorMessage(postLoadError, language)}
          </div>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant="destructive" className="items-center">
          <AlertCircle className="size-5 shrink-0" />
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
            {validationErrors.map((message, index) => (
              <li key={index}>{message}</li>
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

      {/* Reference layout, adapted: what you publish on the left, where and when
          on the right. Below the large breakpoint the columns stack, content
          first, so phone widths keep one reading order. */}
      <div className="grid min-w-0 grow grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
        <div className="flex min-w-0 flex-col gap-4">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex shrink-0 grow flex-col gap-4"
          >
            <TabsList
              variant="line"
              className="w-full overflow-x-auto"
              aria-label={t("Composer sections")}
            >
              <TabsTrigger value="shared" className="text-xs font-semibold">
                <Layers className="size-3.5 mr-1.5" />
                {t("Shared Content")}
              </TabsTrigger>
              {selectedChannels.map((channel: ChannelIntegration) => (
                <TabsTrigger
                  key={channel.id}
                  value={channel.id}
                  className="text-xs font-medium flex items-center gap-1.5"
                >
                  <span>{channel.name}</span>
                  {channelOverrides[channel.id]?.hasOverride && (
                    <span className="size-1.5 rounded-full bg-foreground" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="flex flex-col gap-4">
              <TabsContent value="shared" className="mt-0">
                <div className="flex flex-col gap-4">
                  <div className="relative">
                    <Textarea
                      placeholder={t("What do you want to publish?")}
                      aria-label={t("Shared Content")}
                      value={sharedContent}
                      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                        setSharedContent(event.target.value);
                        markDirty();
                      }}
                      className="min-h-[140px] text-base resize-y font-normal bg-field"
                    />
                    <div className="flex items-center justify-between text-xs text-ink-3 mt-2">
                      <span>
                        {t("Targeting {count} channel(s)", { count: selectedChannels.length })}
                      </span>
                      <span className="font-mono">
                        {t("{count} characters", { count: sharedContent.length })}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-(length:--font-size-ui) font-semibold text-ink">
                        {t("Attached Media ({count})", { count: attachments.length })}
                      </h3>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            replaceTargetRef.current = null;
                            fileInputRef.current?.click();
                          }}
                          disabled={selectedBrandProfileId === null || !scope.isSignedIn}
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
                    </div>

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
                      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
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
                                    className="h-1 bg-accent transition-all w-[var(--attachment-progress)]"
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
                              <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100">
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
                                  aria-label={t("Replace attachment {index}", { index: index + 1 })}
                                  disabled={selectedBrandProfileId === null}
                                  onClick={() => {
                                    replaceTargetRef.current = attachment.key;
                                    fileInputRef.current?.click();
                                  }}
                                  className="size-5 rounded-full bg-surface/80 text-ink shadow hover:bg-accent-tint"
                                >
                                  <Replace className="size-3" />
                                </Button>
                                {attachment.uploadStatus === "failed" &&
                                  attachment.hasLocalFile && (
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
                                {/* An unfinished upload is stopped by the same action that
                                  removes it, so the row shows exactly one destructive
                                  control whose label states the real effect. */}
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
                      </div>
                      {attachments.length === 0 && (
                        <p className="py-6 text-center text-xs text-ink-3">
                          {t(
                            "Drag images or videos here, or use Add Media. Attachments keep their order.",
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </TabsContent>

              {selectedChannels.map((channel: ChannelIntegration) => {
                const override = channelOverrides[channel.id] ?? {
                  content: sharedContent,
                  hasOverride: false,
                  settings: {},
                };
                const distribution = postQuery.data?.distributions.find(
                  (item) => item.platform_account_id === channel.id,
                );
                const channelAttachments = attachmentsForChannel(channel.id);
                const inheritsAttachments = !attachmentOverrides[channel.id];

                return (
                  <TabsContent key={channel.id} value={channel.id} className="mt-0">
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-line pb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink">{channel.name}</span>
                          <Badge variant="outline" className="font-mono text-xs uppercase">
                            {channel.providerIdentifier}
                          </Badge>
                          {distribution && (
                            <Badge
                              variant="outline"
                              className="text-(length:--font-size-micro) uppercase"
                            >
                              {tStatus(distribution.status)}
                            </Badge>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant={override.hasOverride ? "secondary" : "outline"}
                          size="sm"
                          onClick={() =>
                            handleChannelOverrideChange(channel.id, {
                              hasOverride: !override.hasOverride,
                              content: override.hasOverride ? sharedContent : override.content,
                            })
                          }
                          className="text-xs"
                        >
                          {override.hasOverride
                            ? t("Remove Custom Override")
                            : t("Customize for This Channel")}
                        </Button>
                      </div>

                      {override.hasOverride && (
                        <div className="flex flex-col gap-2">
                          <label
                            htmlFor={`channel-override-text-${channel.id}`}
                            className="text-xs font-medium text-ink-3"
                          >
                            {t("Custom Text for {name}", { name: channel.name })}
                          </label>
                          <Textarea
                            id={`channel-override-text-${channel.id}`}
                            value={override.content}
                            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                              handleChannelOverrideChange(channel.id, {
                                content: event.target.value,
                              })
                            }
                            className="min-h-[120px] text-sm resize-y"
                          />
                          <span className="text-(length:--font-size-micro) text-ink-3 self-end font-mono">
                            {t("{count} characters", { count: override.content.length })}
                          </span>
                        </div>
                      )}

                      <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-ink">
                          {t("Attachments for {name}", { name: channel.name })}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant={inheritsAttachments ? "secondary" : "outline"}
                            size="sm"
                            className="text-xs"
                            aria-pressed={inheritsAttachments}
                            onClick={() => handleSetChannelAttachments(channel.id, null)}
                          >
                            {t("Use all post attachments")}
                          </Button>
                          <Button
                            type="button"
                            variant={
                              !inheritsAttachments && channelAttachments.length === 0
                                ? "secondary"
                                : "outline"
                            }
                            size="sm"
                            className="text-xs"
                            aria-pressed={!inheritsAttachments && channelAttachments.length === 0}
                            onClick={() => handleSetChannelAttachments(channel.id, [])}
                          >
                            {t("Text only")}
                          </Button>
                        </div>
                        {attachments.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {attachments.map((attachment, index) => {
                              const assetId = attachment.assetId;
                              if (!assetId) return null;
                              const selected = channelAttachments.some(
                                (item) => item.assetId === assetId,
                              );
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
                      </div>

                      <PlatformSettings
                        provider={channel.providerIdentifier}
                        channelName={channel.name}
                        channelId={channel.id}
                        settings={override.settings}
                        onChange={(newSettings) =>
                          handleChannelOverrideChange(channel.id, { settings: newSettings })
                        }
                        onRequirementsChange={handleRequirementsChange}
                      />
                    </div>
                  </TabsContent>
                );
              })}
            </div>
          </Tabs>
        </div>

        {/* Where and when: the destinations block and the publishing controls the
            reference keeps beside the editor, so nothing about targeting or timing
            hides behind a tab. */}
        <div className="flex min-w-0 flex-col gap-6 lg:border-l lg:border-line lg:pl-8">
          <DestinationSelector onNavigate={onNavigate} />

          <section className="flex flex-col gap-3 border-t border-line pt-5">
            <h3 className="text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3">
              {t("Publishing")}
            </h3>

            <SegmentedControl
              options={PUBLISH_MODES}
              value={publishMode}
              onChange={setPublishMode}
              label={t("Publishing")}
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
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="composer-schedule-date"
                  className="text-(length:--font-size-micro) font-medium text-ink-3"
                >
                  {t("Date & time")}
                </label>
                <Input
                  id="composer-schedule-date"
                  type="datetime-local"
                  value={scheduleDate}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setScheduleDate(event.target.value);
                    markDirty();
                  }}
                  className="h-9 bg-field"
                />
              </div>
            )}

            {/* The save state belongs to the draft, not to the action bar. */}
            <p className="text-(length:--font-size-micro) text-ink-3" role="status">
              {savedAt && !isDirty
                ? t("Saved to your workspace at {time}", {
                    time: new Date(savedAt).toLocaleTimeString(language),
                  })
                : isDirty
                  ? t("Unsaved changes are kept in this browser until you save.")
                  : t("Draft changes are saved to your workspace when you save.")}
            </p>
          </section>
        </div>
      </div>

      {/* One primary action stays in view; the publishing selector above decides
          what it submits, so the bar never repeats a control the body owns. */}
      <div className="sticky bottom-0 -mx-4 flex shrink-0 justify-end border-t border-line bg-surface px-4 py-2.5 sm:-mx-6 sm:px-6">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void handleSubmit(publishMode)}
          disabled={submitDisabled || (publishMode === "schedule" && !scheduleDate)}
          className="h-8 gap-1.5"
          title={
            publishMode === "draft"
              ? t("Saves this post's text, attachments, and channel settings without publishing")
              : undefined
          }
        >
          {isSubmitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <PublishModeIcon className="size-3.5" />
          )}
          {publishModeAction(publishMode, postId, t)}
        </Button>
      </div>
    </fieldset>
  );
}
