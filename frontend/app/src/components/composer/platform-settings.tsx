import React, { useEffect, useId } from "react";
import { Input } from "@meltiply/ui/input";
import { Button } from "@meltiply/ui/button";
import { Switch } from "@meltiply/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { useSessionScope } from "@/hooks/use-session-scope";
import { usePlatformPublishingRequirements } from "@/lib/queries";
import { useI18n, type TranslationValues } from "@/lib/i18n";
import type { YoutubeSettings, TikTokSettings } from "@/api/types";
import type {
  PlatformCapability,
  PostTargetInput,
  TikTokPrivacyLevel,
  TikTokPublishingRequirements,
} from "@/types";

/**
 * One saved Post target: a Channel paired with its own caption overrides,
 * provider options, and attachment selection. Draft saving and scheduling
 * both send this shape, so a target round-trips through the same field names.
 */
export type PostTargetDraft = PostTargetInput;

/** Localized translate function signature shared by descriptor hooks. */
type Translate = (message: string, values?: TranslationValues) => string;

/**
 * Composer-only TikTok settings: the contract `TikTokSettings` plus disclosure
 * flags that persist through `provider_options.tiktok` but live outside the
 * base settings interface.
 */
interface TikTokComposerSettings extends TikTokSettings {
  auto_add_music?: boolean;
  brand_content?: boolean;
  brand_organic?: boolean;
  is_ai_generated?: boolean;
  disclose?: boolean;
}

/**
 * Props handed to a provider descriptor's settings editor. `settings` is the
 * provider-narrowed view produced by the descriptor's `read` boundary, so
 * editors never cast the raw settings map themselves.
 */
interface ProviderEditorProps<S> {
  /** Display name of the connected channel destination. */
  channelName: string;
  /** Provider-typed view over the channel's raw settings map. */
  settings: Partial<S>;
  /** Merges one key into the raw settings map and reports the change upward. */
  update: (key: string, value: unknown) => void;
  /** Applies related choices atomically against the same settings snapshot. */
  updateMany: (patch: Record<string, unknown>) => void;
  /** Live TikTok publishing requirements when the descriptor opted in; otherwise null. */
  requirements: TikTokPublishingRequirements | null;
  /** Actual attachment kinds for this Channel, not the Post's full media set. */
  mediaKinds: readonly ("image" | "video")[];
  /** Localized translate function. */
  t: Translate;
}

/**
 * Context handed to a provider descriptor's `validate` hook during composer's
 * submit-time validation.
 */
interface ProviderValidationContext<S> {
  /** Display name used to prefix violation messages. */
  channelName: string;
  /** Provider-typed view over the channel's raw settings map. */
  settings: Partial<S>;
  /** Contract capability record for the provider, when loaded. */
  capability: PlatformCapability | undefined;
  /** Live TikTok publishing requirements reported by the settings panel. */
  requirements: TikTokPublishingRequirements | null;
  mediaKinds: readonly ("image" | "video")[];
  /** Localized translate function. */
  t: Translate;
}

/**
 * Typed per-provider specification: the single provider boundary owning
 * settings narrowing, editor rendering, contract target mapping, and
 * submit-time validation for one provider family.
 */
interface ProviderSpec<S> {
  /** Normalized provider identifiers this descriptor serves (compared lowercase). */
  providers: readonly string[];
  /** When true, the panel fetches live TikTok publishing requirements for the channel. */
  usesRequirements?: boolean;
  /** Narrows the raw settings map to the provider's typed settings shape. */
  read: (settings: Record<string, unknown>) => Partial<S>;
  /** Settings editor panel rendered inside the channel tab. */
  Editor: React.ComponentType<ProviderEditorProps<S>>;
  /** Maps settings to draft intent or permission-clamped delivery; omit when no contract fields apply. */
  applyTarget?: (
    target: PostTargetDraft,
    settings: Partial<S>,
    mediaKinds: readonly ("image" | "video")[],
    requirements: TikTokPublishingRequirements | null,
    purpose: "draft" | "publication",
  ) => void;
  /**
   * Rebuilds the raw settings map from a persisted Post target so an edited
   * post rehydrates its provider controls. Fields the provider does not write
   * (or wrote as `null`) remain unanswered unless that control has a documented default.
   */
  readTarget?: (target: PostTargetDraft) => Partial<S>;
  /** Returns localized submit-time violations for the channel; empty when valid. */
  validate?: (context: ProviderValidationContext<S>) => string[];
}

/**
 * Public provider descriptor shape: the type-erased form of `ProviderSpec`
 * stored in the registry and consumed by `PlatformSettings` and the composer.
 * Narrowing happens once inside `read`, so consumers stay provider-agnostic.
 */
export interface ProviderDescriptor {
  usesRequirements?: boolean;
  providers: readonly string[];
  read: (settings: Record<string, unknown>) => Record<string, unknown>;
  Editor: React.ComponentType<ProviderEditorProps<Record<string, unknown>>>;
  applyTarget?: (
    target: PostTargetDraft,
    settings: Record<string, unknown>,
    mediaKinds: readonly ("image" | "video")[],
    requirements: TikTokPublishingRequirements | null,
    purpose: "draft" | "publication",
  ) => void;
  readTarget?: (target: PostTargetDraft) => Record<string, unknown>;
  validate?: (context: ProviderValidationContext<Record<string, unknown>>) => string[];
}

/**
 * Registers a typed provider spec into the erased registry shape.
 *
 * The wrapper performs the single raw→typed narrowing through `spec.read`, so
 * each provider's editor, target mapping, and validation operate on
 * `Partial<S>` while `PlatformSettings` and the composer handle only the raw
 * settings map.
 *
 * @param spec - Provider-typed specification.
 * @returns Erased descriptor for the provider registry.
 */
function defineProviderDescriptor<S>(spec: ProviderSpec<S>): ProviderDescriptor {
  const { Editor, applyTarget, read, readTarget, validate } = spec;
  const ErasedEditor = (props: ProviderEditorProps<Record<string, unknown>>) => (
    <Editor
      channelName={props.channelName}
      settings={read(props.settings)}
      update={props.update}
      updateMany={props.updateMany}
      requirements={props.requirements}
      t={props.t}
      mediaKinds={props.mediaKinds}
    />
  );
  return {
    providers: spec.providers,
    usesRequirements: spec.usesRequirements,
    read,
    Editor: ErasedEditor,
    applyTarget: applyTarget
      ? (target, settings, mediaKinds, requirements, purpose) =>
          applyTarget(target, read(settings), mediaKinds, requirements, purpose)
      : undefined,
    readTarget: readTarget ? (target) => ({ ...readTarget(target) }) : undefined,
    validate: validate
      ? (context) => validate({ ...context, settings: read(context.settings) })
      : undefined,
  };
}

/**
 * Shared panel chrome for a provider settings editor: the bordered card with
 * the "{name} Configuration" heading. The enclosing section identifies its provider.
 * Its inline-size container makes setting grids respond to the panel, not the viewport.
 */
function ProviderPanel({
  channelName,
  t,
  children,
}: {
  channelName: string;
  t: Translate;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="@container flex flex-col gap-4 rounded-control border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink flex items-center gap-2">
          {t("{name} Configuration", { name: channelName })}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * YouTube settings editor: title/tags plus the existing target's audience and
 * visibility options. Both choices remain unanswered until explicitly selected
 * and survive draft reopen without borrowing the adapter's Public default.
 */
function YoutubeEditor({
  channelName,
  settings: yt,
  update,
  t,
}: ProviderEditorProps<YoutubeSettings>): React.ReactElement {
  const fieldId = useId();
  const tagsString = (yt.tags ?? []).map((tag) => tag.label).join(", ");

  /**
   * Parses a comma-delimited tag string into the label/value tag objects the
   * YouTube settings shape requires, trimming whitespace and dropping empties.
   * Example: `"tech, news"` -> `[{ value: "tech", label: "tech" }, { value: "news", label: "news" }]`
   */
  const handleTagsChange = (val: string) => {
    const parsed = val
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)
      .map((tag: string) => ({ value: tag, label: tag }));
    update("tags", parsed);
  };

  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${fieldId}-title`} className="text-xs font-medium text-ink-3">
            {t("Video Title (required, 2-100 characters)")}
          </label>
          <Input
            id={`${fieldId}-title`}
            placeholder={t("Enter YouTube title...")}
            value={yt.title ?? ""}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => update("title", e.target.value)}
            maxLength={100}
          />
          <span className="text-(length:--font-size-micro) text-ink-3 self-end">
            {(yt.title ?? "").length}/100
          </span>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${fieldId}-tags`} className="text-xs font-medium text-ink-3">
            {t("Tags (comma separated, max 500 chars combined)")}
          </label>
          <Input
            id={`${fieldId}-tags`}
            placeholder={t("tech, tutorial, social media")}
            value={tagsString}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleTagsChange(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-visibility`} className="text-xs font-medium text-ink-3">
            {t("Visibility")}
          </label>
          <Select value={yt.type ?? ""} onValueChange={(value) => update("type", value)}>
            <SelectTrigger id={`${fieldId}-visibility`}>
              <SelectValue placeholder={t("Choose visibility")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">{t("Public")}</SelectItem>
              <SelectItem value="unlisted">{t("Unlisted")}</SelectItem>
              <SelectItem value="private">{t("Private")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-audience`} className="text-xs font-medium text-ink-3">
            {t("Made for kids")}
          </label>
          <Select
            value={yt.selfDeclaredMadeForKids ?? ""}
            onValueChange={(value) => update("selfDeclaredMadeForKids", value)}
          >
            <SelectTrigger id={`${fieldId}-audience`}>
              <SelectValue placeholder={t("Choose an audience")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="yes">{t("Yes, made for kids")}</SelectItem>
              <SelectItem value="no">{t("No, not made for kids")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-license`} className="text-xs font-medium text-ink-3">
          {t("License")}
        </label>
        <Select
          value={yt.license ?? "standard"}
          onValueChange={(value) => update("license", value === "standard" ? undefined : value)}
        >
          <SelectTrigger id={`${fieldId}-license`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{t("Standard YouTube license")}</SelectItem>
            <SelectItem value="creativeCommon">{t("Creative Commons")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* publishAt is only valid on a private video, so the control is hidden
          for other visibilities instead of producing a rejected publish. */}
      {yt.type === "private" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-publish-at`} className="text-xs font-medium text-ink-3">
            {t("Publish at")}
          </label>
          <Input
            id={`${fieldId}-publish-at`}
            type="datetime-local"
            value={yt.publishAt ?? ""}
            onChange={(event) =>
              update(
                "publishAt",
                event.target.value ? new Date(event.target.value).toISOString() : undefined,
              )
            }
          />
          <p className="text-xs text-ink-3">
            {t("YouTube publishes the video at this time while it stays private until then.")}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-control border border-line p-3">
        <label
          htmlFor={`${fieldId}-stats`}
          className="flex min-h-12 items-center justify-between gap-3"
        >
          <span className="text-xs font-medium text-ink">{t("Show public stats")}</span>
          <Switch
            id={`${fieldId}-stats`}
            checked={yt.publicStatsViewable ?? true}
            onCheckedChange={(checked) => update("publicStatsViewable", checked)}
          />
        </label>
        <label
          htmlFor={`${fieldId}-embeddable`}
          className="flex min-h-12 items-center justify-between gap-3"
        >
          <span className="text-xs font-medium text-ink">{t("Allow embedding")}</span>
          <Switch
            id={`${fieldId}-embeddable`}
            checked={yt.embeddable ?? true}
            onCheckedChange={(checked) => update("embeddable", checked)}
          />
        </label>
        <label
          htmlFor={`${fieldId}-synthetic`}
          className="flex min-h-12 items-center justify-between gap-3"
        >
          <span className="text-xs font-medium text-ink">{t("Altered or synthetic content")}</span>
          <Switch
            id={`${fieldId}-synthetic`}
            checked={yt.containsSyntheticMedia ?? false}
            onCheckedChange={(checked) => update("containsSyntheticMedia", checked)}
          />
        </label>
      </div>
    </ProviderPanel>
  );
}

/**
 * TikTok's creator-scoped controls: no fallback privacy options or implicit
 * interaction grants. Photo targets hide video-only features and the payload
 * boundary clears them. Disclosure subtypes and policy guidance follow the
 * current Direct Post requirements; publishing is the explicit consent action.
 */
function TikTokEditor({
  channelName,
  settings: tt,
  update,
  requirements,
  mediaKinds,
  t,
}: ProviderEditorProps<TikTokComposerSettings>): React.ReactElement {
  const fieldId = useId();
  const photo = mediaKinds.includes("image");
  const disclose = tt.disclose ?? Boolean(tt.brand_content || tt.brand_organic);
  const privacyLabels: Record<TikTokPrivacyLevel, string> = {
    PUBLIC_TO_EVERYONE: t("Public to Everyone"),
    MUTUAL_FOLLOW_FRIENDS: t("Friends Only"),
    FOLLOWER_OF_CREATOR: t("Followers"),
    SELF_ONLY: t("Private (Self Only)"),
  };
  const toggles = [
    {
      field: "comment",
      label: t("Comments"),
      checked: tt.comment ?? false,
      disabled: !requirements?.comment_allowed,
      visible: true,
    },
    {
      field: "duet",
      label: t("Duet"),
      checked: tt.duet ?? false,
      disabled: !requirements?.duet_allowed,
      visible: !photo,
    },
    {
      field: "stitch",
      label: t("Stitch"),
      checked: tt.stitch ?? false,
      disabled: !requirements?.stitch_allowed,
      visible: !photo,
    },
    {
      field: "is_ai_generated",
      label: t("AI Generated"),
      checked: tt.is_ai_generated ?? false,
      disabled: false,
      visible: !photo,
    },
  ] as const;
  return (
    <ProviderPanel channelName={channelName} t={t}>
      {requirements && (
        <p className="text-xs text-ink-2">
          {t("Posting as {name}", { name: requirements.creator.display_name })}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-title`} className="text-xs font-medium text-ink-3">
          {t("Post Title (optional, max 90 characters)")}
        </label>
        <Input
          id={`${fieldId}-title`}
          placeholder={t("TikTok post title...")}
          value={tt.title ?? ""}
          onChange={(event) => update("title", event.target.value)}
          maxLength={90}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-privacy`} className="text-xs font-medium text-ink-3">
          {t("Privacy Level")}
        </label>
        <Select
          value={
            tt.privacy_level && requirements?.privacy_levels.includes(tt.privacy_level)
              ? tt.privacy_level
              : ""
          }
          onValueChange={(value) => update("privacy_level", value)}
          disabled={!requirements}
        >
          <SelectTrigger id={`${fieldId}-privacy`}>
            <SelectValue placeholder={t("Select privacy")} />
          </SelectTrigger>
          <SelectContent>
            {(requirements?.privacy_levels ?? []).map((level) => (
              <SelectItem
                key={level}
                value={level}
                disabled={disclose && tt.brand_content === true && level === "SELF_ONLY"}
              >
                {privacyLabels[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-x-6 @sm:grid-cols-2">
        {toggles
          .filter((toggle) => toggle.visible)
          .map((toggle) => (
            <label
              key={toggle.field}
              htmlFor={`${fieldId}-${toggle.field}`}
              className="flex min-h-12 min-w-0 cursor-pointer items-center justify-between gap-3 py-2 has-[:disabled]:cursor-not-allowed"
            >
              <span className="min-w-0 text-xs font-medium text-ink">{toggle.label}</span>
              <Switch
                id={`${fieldId}-${toggle.field}`}
                checked={toggle.checked && !toggle.disabled}
                disabled={toggle.disabled}
                onCheckedChange={(checked) => update(toggle.field, checked)}
              />
            </label>
          ))}
      </div>
      {photo && (
        <label
          htmlFor={`${fieldId}-auto-music`}
          className="flex min-h-12 items-center justify-between gap-3"
        >
          <span className="text-xs font-medium text-ink">
            {t("Automatically add recommended music")}
          </span>
          <Switch
            id={`${fieldId}-auto-music`}
            checked={tt.auto_add_music ?? false}
            onCheckedChange={(checked) => update("auto_add_music", checked)}
          />
        </label>
      )}
      <label
        htmlFor={`${fieldId}-disclose`}
        className="flex min-h-12 items-center justify-between gap-3"
      >
        <span className="text-xs font-medium text-ink">{t("Disclose commercial content")}</span>
        <Switch
          id={`${fieldId}-disclose`}
          checked={disclose}
          onCheckedChange={(checked) => update("disclose", checked)}
        />
      </label>
      {disclose && (
        <div className="flex flex-col gap-2">
          <label
            htmlFor={`${fieldId}-organic`}
            className="flex min-h-12 items-center justify-between gap-3"
          >
            <span className="text-xs font-medium text-ink">{t("Organic Brand")}</span>
            <Switch
              id={`${fieldId}-organic`}
              checked={tt.brand_organic ?? false}
              onCheckedChange={(checked) => update("brand_organic", checked)}
            />
          </label>
          <label
            htmlFor={`${fieldId}-brand`}
            className="flex min-h-12 items-center justify-between gap-3"
          >
            <span className="text-xs font-medium text-ink">{t("Brand Content")}</span>
            <Switch
              id={`${fieldId}-brand`}
              checked={tt.brand_content ?? false}
              disabled={tt.privacy_level === "SELF_ONLY" && tt.brand_content !== true}
              onCheckedChange={(checked) => update("brand_content", checked)}
            />
          </label>
          <p className="text-xs text-ink-3">{t("Branded content cannot be private.")}</p>
          {(tt.brand_content || tt.brand_organic) && (
            <p className="text-xs text-ink-2">
              {tt.brand_content
                ? t("Your post will be labeled Paid partnership.")
                : t("Your post will be labeled Promotional content.")}
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-ink-2">
        {t("By posting, you agree to TikTok's")}{" "}
        {disclose && tt.brand_content && (
          <>
            <a
              className="text-accent-ink underline"
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("Branded Content Policy")}
            </a>
            {" · "}
          </>
        )}
        <a
          className="text-accent-ink underline"
          href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("Music Usage Confirmation")}
        </a>
      </p>
      <p className="text-xs text-ink-3">
        {t("TikTok may take a few minutes to process your post.")}
      </p>
    </ProviderPanel>
  );
}

/**
 * Composer-only Instagram choices persisted in `provider_options.instagram`.
 * `post_type` is deliberately unanswered until the creator selects a shape so
 * the adapter's documented image/feed and video/Reel defaults remain in force.
 */
interface InstagramComposerSettings {
  post_type?: "feed" | "reel" | "story";
  trial_graduation?: "manual" | "performance";
  trial_reel?: boolean;
  alt_text?: string;
  location_id?: string;
  cover_url?: string;
  cover_frame_ms?: number;
  audio_name?: string;
  is_ai_generated?: boolean;
}

/**
 * Composer-only Threads settings: the saved controls this editor owns.
 */
interface ThreadsComposerSettings {
  topic_tag?: string;
  reply_control?:
    | "everyone"
    | "accounts_you_follow"
    | "mentioned_only"
    | "parent_post_author_only"
    | "followers_only";
  link_attachment?: string;
}

/**
 * Instagram publication shape controls. Feed accepts one or a carousel; Reel
 * and Story require exactly one attachment, and a trial Reel must be a Reel.
 * The controls are limited by the actual attachment kinds so an impossible
 * choice is never offered.
 */
function InstagramEditor({
  channelName,
  settings: instagram,
  update,
  updateMany,
  mediaKinds,
  t,
}: ProviderEditorProps<InstagramComposerSettings>): React.ReactElement {
  const fieldId = useId();
  const single = mediaKinds.length === 1;
  const hasVideo = mediaKinds.includes("video");
  const postType = instagram.post_type ?? "";
  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-post-type`} className="text-xs font-medium text-ink-3">
          {t("Post type")}
        </label>
        <Select
          value={postType}
          onValueChange={(value) =>
            updateMany({
              post_type: value,
              ...(value !== "reel" ? { trial_reel: false } : {}),
            })
          }
        >
          <SelectTrigger id={`${fieldId}-post-type`}>
            <SelectValue placeholder={t("Choose the Instagram post type")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="feed">{t("Feed")}</SelectItem>
            <SelectItem value="reel" disabled={!single || !hasVideo}>
              {t("Reel")}
            </SelectItem>
            <SelectItem value="story" disabled={!single}>
              {t("Story")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-ink-3">
          {single
            ? t("Reels require one video; Stories require one image or video.")
            : t("Multiple attachments publish as one feed carousel.")}
        </p>
      </div>
      {postType === "reel" && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <label
            htmlFor={`${fieldId}-trial`}
            className="flex min-h-12 items-center justify-between gap-3"
          >
            <span className="text-xs font-medium text-ink">{t("Trial Reel")}</span>
            <Switch
              id={`${fieldId}-trial`}
              checked={instagram.trial_reel ?? false}
              onCheckedChange={(checked) => update("trial_reel", checked)}
            />
          </label>
          <p className="text-xs text-ink-3">
            {t("Trial Reels are shown to non-followers first; you can graduate them later.")}
          </p>
          {instagram.trial_reel && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${fieldId}-graduation`} className="text-xs font-medium text-ink-3">
                {t("Graduation")}
              </label>
              <Select
                value={instagram.trial_graduation ?? "manual"}
                onValueChange={(value) => update("trial_graduation", value)}
              >
                <SelectTrigger id={`${fieldId}-graduation`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">{t("Graduate manually")}</SelectItem>
                  <SelectItem value="performance">
                    {t("Graduate automatically when it performs well")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
      {mediaKinds.includes("image") && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-alt`} className="text-xs font-medium text-ink-3">
            {t("Alt text")}
          </label>
          <Input
            id={`${fieldId}-alt`}
            maxLength={1000}
            value={instagram.alt_text ?? ""}
            onChange={(event) => update("alt_text", event.target.value || undefined)}
          />
          <p className="text-xs text-ink-3">
            {t("Describes the image for screen readers. Instagram limits it to 1,000 characters.")}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-location`} className="text-xs font-medium text-ink-3">
          {t("Location ID")}
        </label>
        <Input
          id={`${fieldId}-location`}
          value={instagram.location_id ?? ""}
          onChange={(event) => update("location_id", event.target.value.trim() || undefined)}
        />
        <p className="text-xs text-ink-3">
          {t("The Facebook Page ID that carries the location you want to tag.")}
        </p>
      </div>
      {postType === "reel" && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-cover`} className="text-xs font-medium text-ink-3">
              {t("Cover image URL")}
            </label>
            <Input
              id={`${fieldId}-cover`}
              type="url"
              inputMode="url"
              placeholder={t("https://example.com/cover.jpg")}
              value={instagram.cover_url ?? ""}
              onChange={(event) => update("cover_url", event.target.value.trim() || undefined)}
            />
            <p className="text-xs text-ink-3">
              {t("Optional. A cover image replaces the frame chosen by offset.")}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-cover-ms`} className="text-xs font-medium text-ink-3">
              {t("Cover frame offset (ms)")}
            </label>
            <Input
              id={`${fieldId}-cover-ms`}
              type="number"
              min={0}
              step={100}
              value={instagram.cover_frame_ms ?? ""}
              onChange={(event) =>
                update(
                  "cover_frame_ms",
                  event.target.value === "" ? undefined : Number(event.target.value),
                )
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-audio`} className="text-xs font-medium text-ink-3">
              {t("Audio name")}
            </label>
            <Input
              id={`${fieldId}-audio`}
              maxLength={255}
              value={instagram.audio_name ?? ""}
              onChange={(event) => update("audio_name", event.target.value || undefined)}
            />
            <p className="text-xs text-ink-3">{t("Instagram allows one rename.")}</p>
          </div>
          <label
            htmlFor={`${fieldId}-ai`}
            className="flex min-h-12 items-center justify-between gap-3"
          >
            <span className="text-xs font-medium text-ink">{t("Made with AI")}</span>
            <Switch
              id={`${fieldId}-ai`}
              checked={instagram.is_ai_generated ?? false}
              onCheckedChange={(checked) => update("is_ai_generated", checked)}
            />
          </label>
        </div>
      )}
    </ProviderPanel>
  );
}

/**
 * Composer-only Facebook settings: the saved Post contract plus the controls
 * this editor owns. Every field maps onto `provider_options.facebook`.
 */
interface FacebookComposerSettings {
  post_type?: "post" | "photo" | "reel" | "story";
  link?: string;
  is_ai_generated?: boolean;
}

/**
 * Facebook settings editor covering each documented Page publishing family.
 *
 * Families are enabled only when the Channel's actual attachment kinds can
 * carry them, mirroring the adapter's endpoint mapping: the feed takes text, a
 * link, or photos; photo posts need 1-10 images; Reels and Stories need exactly
 * one video. AI disclosure appears only for the two families that document it.
 */
function FacebookEditor({
  channelName,
  settings,
  update,
  updateMany,
  mediaKinds,
  t,
}: ProviderEditorProps<FacebookComposerSettings>): React.ReactElement {
  const fieldId = useId();
  const postType = settings.post_type ?? "";
  const imageCount = mediaKinds.filter((kind) => kind === "image").length;
  const hasVideo = mediaKinds.includes("video");
  const single = mediaKinds.length === 1;
  const onlyImages = mediaKinds.length > 0 && !hasVideo;
  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-post-type`} className="text-xs font-medium text-ink-3">
          {t("Post type")}
        </label>
        <Select
          value={postType}
          onValueChange={(value) =>
            updateMany({
              post_type: value,
              ...(value === "reel" || value === "story" ? {} : { is_ai_generated: false }),
              ...(value === "post" ? {} : { link: undefined }),
            })
          }
        >
          <SelectTrigger id={`${fieldId}-post-type`}>
            <SelectValue placeholder={t("Choose the Facebook post type")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="post" disabled={hasVideo}>
              {t("Post")}
            </SelectItem>
            <SelectItem value="photo" disabled={!onlyImages || imageCount > 10}>
              {t("Photo post")}
            </SelectItem>
            <SelectItem value="reel" disabled={!single || !hasVideo}>
              {t("Reel")}
            </SelectItem>
            <SelectItem value="story" disabled={!single || !hasVideo}>
              {t("Story")}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-ink-3">
          {t("Posts take text, a link, or up to ten photos. Reels and Stories take one video.")}
        </p>
      </div>
      {postType === "post" && mediaKinds.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-link`} className="text-xs font-medium text-ink-3">
            {t("Link")}
          </label>
          <Input
            id={`${fieldId}-link`}
            type="url"
            inputMode="url"
            placeholder={t("https://example.com")}
            value={settings.link ?? ""}
            onChange={(event) => update("link", event.target.value.trim() || undefined)}
          />
          <p className="text-xs text-ink-3">
            {t("Optional. A Page post needs text, a link, or a photo.")}
          </p>
        </div>
      )}
      {(postType === "reel" || postType === "story") && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <label
            htmlFor={`${fieldId}-ai`}
            className="flex min-h-12 items-center justify-between gap-3"
          >
            <span className="text-xs font-medium text-ink">{t("Made with AI")}</span>
            <Switch
              id={`${fieldId}-ai`}
              checked={settings.is_ai_generated ?? false}
              onCheckedChange={(checked) => update("is_ai_generated", checked)}
            />
          </label>
          <p className="text-xs text-ink-3">
            {t("Discloses to Facebook that this media was created or edited with AI.")}
          </p>
        </div>
      )}
      {postType && (
        <p className="text-xs text-ink-2">
          {t("This will be shared publicly on your Facebook Page.")}
        </p>
      )}
    </ProviderPanel>
  );
}

/**
 * Threads settings editor covering the controls Threads documents for a post.
 *
 * A topic tag is limited to one per post and forbids `.` and `&`; reply control
 * narrows who may respond; a link attachment applies to text-only posts, which
 * is why it is hidden as soon as the Channel carries media.
 */
function ThreadsEditor({
  channelName,
  settings,
  update,
  mediaKinds,
  t,
}: ProviderEditorProps<ThreadsComposerSettings>): React.ReactElement {
  const fieldId = useId();
  const hasMedia = mediaKinds.length > 0;
  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-topic`} className="text-xs font-medium text-ink-3">
          {t("Topic tag")}
        </label>
        <Input
          id={`${fieldId}-topic`}
          maxLength={50}
          value={settings.topic_tag ?? ""}
          onChange={(event) => update("topic_tag", event.target.value.trim() || undefined)}
        />
        <p className="text-xs text-ink-3">
          {t("One tag per post, up to 50 characters. Periods and ampersands are not allowed.")}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-reply`} className="text-xs font-medium text-ink-3">
          {t("Who can reply")}
        </label>
        <Select
          value={settings.reply_control ?? "everyone"}
          onValueChange={(value) => update("reply_control", value)}
        >
          <SelectTrigger id={`${fieldId}-reply`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="everyone">{t("Everyone")}</SelectItem>
            <SelectItem value="accounts_you_follow">{t("Accounts you follow")}</SelectItem>
            <SelectItem value="mentioned_only">{t("Mentioned accounts only")}</SelectItem>
            <SelectItem value="followers_only">{t("Followers only")}</SelectItem>
            <SelectItem value="parent_post_author_only">{t("Only the original author")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {!hasMedia && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${fieldId}-link`} className="text-xs font-medium text-ink-3">
            {t("Link attachment")}
          </label>
          <Input
            id={`${fieldId}-link`}
            type="url"
            inputMode="url"
            placeholder={t("https://example.com")}
            value={settings.link_attachment ?? ""}
            onChange={(event) => update("link_attachment", event.target.value.trim() || undefined)}
          />
          <p className="text-xs text-ink-3">{t("Threads attaches links to text posts only.")}</p>
        </div>
      )}
    </ProviderPanel>
  );
}

/**
 * Registry of typed provider descriptors — the single provider boundary for
 * settings narrowing, editor selection, Post target mapping (both directions),
 * and submit-time validation. Provider lookup is by normalized identifier.
 */
const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  defineProviderDescriptor<YoutubeSettings>({
    providers: ["youtube"],
    read: (settings) => settings as Partial<YoutubeSettings>,
    Editor: YoutubeEditor,
    applyTarget: (target, yt) => {
      const title = yt.title?.trim();
      if (title) target.title_override = title;
      const tags = (yt.tags ?? []).map((tag) => tag.label).filter(Boolean);
      if (tags.length > 0) target.hashtags = tags;
      target.provider_options = {
        ...target.provider_options,
        youtube: {
          ...(yt.selfDeclaredMadeForKids !== undefined
            ? { made_for_kids: yt.selfDeclaredMadeForKids === "yes" }
            : {}),
          ...(yt.type ? { privacy_status: yt.type } : {}),
          ...(yt.license ? { license: yt.license } : {}),
          ...(yt.publicStatsViewable !== undefined
            ? { public_stats_viewable: yt.publicStatsViewable }
            : {}),
          ...(yt.embeddable !== undefined ? { embeddable: yt.embeddable } : {}),
          ...(yt.containsSyntheticMedia !== undefined
            ? { contains_synthetic_media: yt.containsSyntheticMedia }
            : {}),
          ...(yt.publishAt ? { publish_at: yt.publishAt } : {}),
          ...(yt.recordingDate ? { recording_date: yt.recordingDate } : {}),
        },
      };
    },
    // Rehydrate the same contract fields the controls save, including false audience.
    readTarget: (target) => {
      const hashtags = target.hashtags ?? [];
      return {
        title: target.title_override ?? undefined,
        tags: hashtags.map((tag) => ({ value: tag, label: tag })),
        type: target.provider_options?.youtube?.privacy_status,
        license: target.provider_options?.youtube?.license,
        publicStatsViewable: target.provider_options?.youtube?.public_stats_viewable,
        embeddable: target.provider_options?.youtube?.embeddable,
        containsSyntheticMedia: target.provider_options?.youtube?.contains_synthetic_media,
        publishAt: target.provider_options?.youtube?.publish_at,
        recordingDate: target.provider_options?.youtube?.recording_date,
        selfDeclaredMadeForKids:
          target.provider_options?.youtube?.made_for_kids !== undefined
            ? target.provider_options.youtube.made_for_kids
              ? "yes"
              : "no"
            : undefined,
      };
    },
    validate: ({ channelName, settings: yt, capability, t }) => {
      const errors: string[] = [];
      const title = (yt.title ?? "").trim();
      if (title.length < 2 || title.length > 100) {
        errors.push(
          t("{name}: YouTube requires a video title between 2 and 100 characters.", {
            name: channelName,
          }),
        );
      }
      if (yt.selfDeclaredMadeForKids === undefined) {
        errors.push(
          t("{name}: choose whether this video is made for kids.", { name: channelName }),
        );
      }
      if (!yt.type) {
        errors.push(t("{name}: choose a YouTube visibility.", { name: channelName }));
      }
      const tags = yt.tags ?? [];
      const maxHashtags = capability?.max_hashtags ?? 30;
      if (tags.length > maxHashtags) {
        errors.push(
          t("{name}: use no more than {limit} tags.", { name: channelName, limit: maxHashtags }),
        );
      }
      const combinedTagLength = tags.map((tag) => tag.label).join(",").length;
      if (combinedTagLength > 500) {
        errors.push(
          t("{name}: YouTube tags cannot exceed 500 characters combined.", { name: channelName }),
        );
      }
      return errors;
    },
  }),
  defineProviderDescriptor<TikTokComposerSettings>({
    providers: ["tiktok", "tiktok-business"],
    usesRequirements: true,
    // TikTok options round-trip through `provider_options.tiktok`; every editable
    // pending Distribution is rewritten by Post scheduling, so no recreate dance
    // is needed for an edited scheduled target.

    read: (settings) => settings as Partial<TikTokComposerSettings>,
    Editor: TikTokEditor,
    applyTarget: (target, tt, mediaKinds, requirements, purpose) => {
      const title = tt.title?.trim();
      if (title) target.title_override = title;
      const photo = mediaKinds.includes("image");
      const disclose = tt.disclose ?? Boolean(tt.brand_content || tt.brand_organic);
      // Drafts retain creator intent; only delivery obeys current permissions.
      const publishing = purpose === "publication";
      target.provider_options = {
        tiktok: {
          ...(tt.privacy_level ? { privacy_level: tt.privacy_level } : {}),
          allow_comment:
            (!publishing || requirements?.comment_allowed === true) && (tt.comment ?? false),
          allow_duet:
            !photo && (!publishing || requirements?.duet_allowed === true) && (tt.duet ?? false),
          allow_stitch:
            !photo &&
            (!publishing || requirements?.stitch_allowed === true) &&
            (tt.stitch ?? false),
          ...(photo ? { auto_add_music: tt.auto_add_music ?? false } : {}),
          brand_content: disclose && (tt.brand_content ?? false),
          brand_organic: disclose && (tt.brand_organic ?? false),
          disclose_commercial_content: disclose,
          is_ai_generated: !photo && (tt.is_ai_generated ?? false),
          music_usage_confirmed: true,
        },
      };
    },
    // Rebuilds the TikTok controls from the persisted target: every editable field
    // lives inside `provider_options.tiktok`, with the optional caption title in
    // `title_override`. Absent options yield an empty map so the editor defaults.
    readTarget: (target) => {
      const options = target.provider_options?.tiktok;
      if (!options) return {};
      return {
        title: target.title_override ?? undefined,
        privacy_level: options.privacy_level,
        comment: options.allow_comment,
        duet: options.allow_duet,
        stitch: options.allow_stitch,
        auto_add_music: options.auto_add_music,
        brand_content: options.brand_content,
        brand_organic: options.brand_organic,
        is_ai_generated: options.is_ai_generated,
        disclose:
          options.disclose_commercial_content ?? (options.brand_content || options.brand_organic),
      };
    },
    validate: ({ channelName, settings: tt, requirements, t }) => {
      const errors: string[] = [];
      const disclose = tt.disclose ?? Boolean(tt.brand_content || tt.brand_organic);
      if (!requirements) {
        errors.push(
          t("{name}: load TikTok creator information before publishing.", { name: channelName }),
        );
      }
      if (disclose && !tt.brand_content && !tt.brand_organic) {
        errors.push(t("Choose your brand, branded content, or both."));
      }
      if (disclose && tt.brand_content && tt.privacy_level === "SELF_ONLY") {
        errors.push(t("Branded content cannot be private."));
      }
      if (!tt.privacy_level) {
        errors.push(t("{name}: choose a TikTok privacy level.", { name: channelName }));
      }
      if (requirements) {
        if (tt.privacy_level && !requirements.privacy_levels.includes(tt.privacy_level)) {
          errors.push(
            t("{name}: the selected privacy level is not available for this creator.", {
              name: channelName,
            }),
          );
        }
      }
      return errors;
    },
  }),
  defineProviderDescriptor<InstagramComposerSettings>({
    providers: ["instagram"],
    read: (settings) => settings as Partial<InstagramComposerSettings>,
    Editor: InstagramEditor,
    applyTarget: (target, instagram) => {
      target.provider_options = {
        ...target.provider_options,
        instagram: {
          ...(instagram.post_type ? { post_type: instagram.post_type } : {}),
          ...(instagram.alt_text ? { alt_text: instagram.alt_text } : {}),
          ...(instagram.location_id ? { location_id: instagram.location_id } : {}),
          ...(instagram.cover_url ? { cover_url: instagram.cover_url } : {}),
          ...(instagram.cover_frame_ms !== undefined
            ? { cover_frame_ms: instagram.cover_frame_ms }
            : {}),
          ...(instagram.audio_name ? { audio_name: instagram.audio_name } : {}),
          ...(instagram.is_ai_generated ? { is_ai_generated: true } : {}),
          ...(instagram.trial_reel ? { trial_reel: true } : {}),
          ...(instagram.trial_reel && instagram.trial_graduation
            ? { trial_graduation: instagram.trial_graduation }
            : {}),
        },
      };
    },
    readTarget: (target) => {
      const options = target.provider_options?.instagram;
      if (!options) return {};
      return {
        post_type: options.post_type,
        trial_reel: options.trial_reel,
        trial_graduation: options.trial_graduation,
        alt_text: options.alt_text,
        location_id: options.location_id,
        cover_url: options.cover_url,
        cover_frame_ms: options.cover_frame_ms,
        audio_name: options.audio_name,
        is_ai_generated: options.is_ai_generated,
      };
    },
    validate: ({ channelName, settings: instagram, mediaKinds, t }) => {
      const errors: string[] = [];
      const single = mediaKinds.length === 1;
      const hasVideo = mediaKinds.includes("video");
      if (instagram.post_type === "reel" && (!single || !hasVideo)) {
        errors.push(t("{name}: Instagram Reels require exactly one video.", { name: channelName }));
      }
      if (instagram.post_type === "story" && !single) {
        errors.push(
          t("{name}: Instagram Stories require exactly one image or video.", { name: channelName }),
        );
      }
      if (instagram.post_type !== "reel" && instagram.trial_reel) {
        errors.push(t("{name}: a trial Reel must use the Reel post type.", { name: channelName }));
      }
      return errors;
    },
  }),
  defineProviderDescriptor<FacebookComposerSettings>({
    providers: ["facebook"],
    read: (settings) => settings as Partial<FacebookComposerSettings>,
    Editor: FacebookEditor,
    applyTarget: (target, facebook) => {
      target.provider_options = {
        facebook: {
          ...(facebook.post_type ? { post_type: facebook.post_type } : {}),
          ...(facebook.post_type === "post" && facebook.link ? { link: facebook.link } : {}),
          ...(facebook.is_ai_generated ? { is_ai_generated: true } : {}),
        },
      };
    },
    // Rehydrates exactly the fields this editor owns; an absent subtree leaves
    // every control unanswered so the adapter keeps inferring the family.
    readTarget: (target) => {
      const options = target.provider_options?.facebook;
      if (!options) return {};
      return {
        post_type: options.post_type,
        link: options.link,
        is_ai_generated: options.is_ai_generated,
      };
    },
    validate: ({ channelName, settings: facebook, mediaKinds, t }) => {
      const errors: string[] = [];
      const hasVideo = mediaKinds.includes("video");
      const single = mediaKinds.length === 1;
      const onlyImages = mediaKinds.length > 0 && !hasVideo;
      if (facebook.post_type === "post" && hasVideo) {
        errors.push(
          t("{name}: Facebook posts cannot carry a video; use a Reel or Story.", {
            name: channelName,
          }),
        );
      }
      if (
        facebook.post_type === "photo" &&
        (!onlyImages || mediaKinds.length < 1 || mediaKinds.length > 10)
      ) {
        errors.push(
          t("{name}: Facebook photo posts need between one and ten images.", { name: channelName }),
        );
      }
      if (
        (facebook.post_type === "reel" || facebook.post_type === "story") &&
        (!single || !hasVideo)
      ) {
        errors.push(
          t("{name}: Facebook Reels and Stories need exactly one video.", { name: channelName }),
        );
      }
      if (facebook.link && facebook.post_type !== "post") {
        errors.push(t("{name}: a link applies to Facebook posts only.", { name: channelName }));
      }
      return errors;
    },
  }),
  defineProviderDescriptor<ThreadsComposerSettings>({
    providers: ["threads"],
    read: (settings) => settings as Partial<ThreadsComposerSettings>,
    Editor: ThreadsEditor,
    applyTarget: (target, threads) => {
      target.provider_options = {
        ...target.provider_options,
        threads: {
          ...(threads.topic_tag ? { topic_tag: threads.topic_tag } : {}),
          ...(threads.reply_control && threads.reply_control !== "everyone"
            ? { reply_control: threads.reply_control }
            : {}),
          ...(threads.link_attachment ? { link_attachment: threads.link_attachment } : {}),
        },
      };
    },
    readTarget: (target) => {
      const options = target.provider_options?.threads;
      if (!options) return {};
      return {
        topic_tag: options.topic_tag,
        reply_control: options.reply_control,
        link_attachment: options.link_attachment,
      };
    },
    validate: ({ channelName, settings: threads, mediaKinds, t }) => {
      const errors: string[] = [];
      if (threads.topic_tag && /[.&]/.test(threads.topic_tag)) {
        errors.push(
          t("{name}: a Threads topic tag cannot contain a period or ampersand.", {
            name: channelName,
          }),
        );
      }
      if (threads.link_attachment && mediaKinds.length > 0) {
        errors.push(t("{name}: Threads attaches links to text posts only.", { name: channelName }));
      }
      return errors;
    },
  }),
];

/**
 * Resolves the provider descriptor for a channel's provider identifier.
 * Matching is case-insensitive against each descriptor's `providers` list.
 *
 * @param provider - Raw provider identifier (e.g. `YouTube`, `tiktok-business`).
 * @returns The matching descriptor, or `undefined` for providers without settings.
 */
export function providerDescriptorFor(provider: string): ProviderDescriptor | undefined {
  const normalized = provider.toLowerCase();
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.providers.includes(normalized));
}

/**
 * Properties for configuring channel-specific social network publication settings.
 */
interface PlatformSettingsProps {
  provider: string;
  channelName: string;
  /** Platform account id — required to fetch live TikTok publishing requirements. */
  channelId: string;
  settings: Record<string, unknown>;
  mediaKinds: readonly ("image" | "video")[];
  onChange: (newSettings: Record<string, unknown>) => void;
  /**
   * Reports the creator's live TikTok publishing requirements to the parent composer
   * so submit-time validation can enforce privacy/permission constraints. Called with
   * `null` when requirements are unavailable or the channel is not TikTok.
   */
  onRequirementsChange?: (
    channelId: string,
    requirements: TikTokPublishingRequirements | null,
  ) => void;
}

/**
 * Dynamic platform-specific settings editor for social destinations.
 *
 * Resolves the channel's provider to its typed descriptor in
 * `PROVIDER_DESCRIPTORS` and renders that descriptor's editor — provider
 * branching and settings narrowing live behind the descriptor boundary rather
 * than in this component. YouTube title/tags and audience/visibility, and TikTok
 * creator options, persist through the existing target contract.
 * The descriptor's `readTarget` restores the same controls when editing.
 *
 * For descriptors marked `usesRequirements` (TikTok) the editor fetches live
 * `PublishingRequirements` and reports them upward via `onRequirementsChange`
 * so the composer can validate before submitting.
 *
 * @param props.provider - Social platform provider identifier (e.g. 'youtube', 'tiktok', 'facebook', 'instagram').
 * @param props.channelName - Display name of the connected channel destination.
 * @param props.channelId - Platform account id used to load live TikTok publishing requirements.
 * @param props.settings - Key-value map of current platform configuration values.
 * @param props.onChange - Callback receiving updated settings map whenever any parameter changes.
 * @param props.onRequirementsChange - Optional sink for live TikTok requirements used by composer validation.
 */
export function PlatformSettings({
  provider,
  channelName,
  channelId,
  mediaKinds,
  settings,
  onChange,
  onRequirementsChange,
}: PlatformSettingsProps) {
  const descriptor = providerDescriptorFor(provider);
  const usesRequirements = descriptor?.usesRequirements === true;
  const scope = useSessionScope();
  const { t } = useI18n();
  const requirementsQuery = usePlatformPublishingRequirements(scope, channelId, usesRequirements);
  const requirements =
    requirementsQuery.isFetchedAfterMount &&
    !requirementsQuery.isError &&
    requirementsQuery.data &&
    requirementsQuery.data.platform === "tiktok"
      ? requirementsQuery.data
      : null;

  // Cached permissions cannot authorize a new composition before its live lookup.
  // Failed refreshes also clear availability; draft settings still round-trip.
  useEffect(() => {
    onRequirementsChange?.(channelId, usesRequirements ? requirements : null);
  }, [channelId, usesRequirements, requirements, onRequirementsChange]);

  const validation =
    descriptor?.validate?.({
      channelName,
      settings,
      capability: undefined,
      requirements,
      mediaKinds,
      t,
    }) ?? [];
  if (!descriptor) return null;

  // Merges one key into the raw settings map and reports the change upward.
  const update = (key: string, value: unknown) => {
    onChange({
      ...settings,
      [key]: value,
    });
  };

  /** Commits coupled Provider choices together so one cannot overwrite another. */
  const updateMany = (patch: Record<string, unknown>) => {
    onChange({ ...settings, ...patch });
  };

  const Editor = descriptor.Editor;
  return (
    <>
      <Editor
        channelName={channelName}
        settings={settings}
        update={update}
        updateMany={updateMany}
        requirements={requirements}
        mediaKinds={mediaKinds}
        t={t}
      />
      {usesRequirements && !requirements && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={requirementsQuery.isFetching}
          onClick={() => void requirementsQuery.refetch()}
        >
          {t("Load TikTok creator information")}
        </Button>
      )}
      {validation.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-ink-3">
          {validation.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </>
  );
}
