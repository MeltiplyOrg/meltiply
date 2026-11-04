import React, { useEffect, useId } from "react";
import { Input } from "@meltiply/ui/input";
import { Button } from "@meltiply/ui/button";
import { Switch } from "@meltiply/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { useSessionScope } from "@/hooks/use-session-scope";
import { usePlatformPublishingRequirements } from "@/lib/queries";
import { useI18n, type TranslationValues } from "@/lib/i18n";
import type { YoutubeSettings, TikTokSettings } from "@/api/types";
import {
  ThreadsPublishingFields,
  threadsTargetOptions,
  type ThreadsComposerSettings,
} from "./threads-settings";
import { InstagramContentFields } from "./instagram-content-fields";
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

type FacebookComposerSettings = NonNullable<
  NonNullable<PostTargetDraft["provider_options"]>["facebook"]
>;
interface YouTubeComposerSettings extends YoutubeSettings {
  post_type?: "video" | "live";
}
/** Localized translate function signature shared by descriptor hooks. */
type Translate = (message: string, values?: TranslationValues) => string;

/**
 * Composer-only TikTok settings: the contract `TikTokSettings` plus disclosure
 * flags that persist through `provider_options.tiktok` but live outside the
 * base settings interface.
 */
interface TikTokComposerSettings extends TikTokSettings {
  post_mode?: "direct" | "inbox";
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
}: ProviderEditorProps<YouTubeComposerSettings>): React.ReactElement {
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
          <label htmlFor={`${fieldId}-method`} className="text-xs font-medium text-ink-3">
            {t("Publishing method")}
          </label>
          <Select
            value={yt.post_type ?? "video"}
            onValueChange={(value) => update("post_type", value)}
          >
            <SelectTrigger id={`${fieldId}-method`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="video">{t("Video or Short")}</SelectItem>
              <SelectItem value="live">{t("Live broadcast")}</SelectItem>
            </SelectContent>
          </Select>
          {yt.post_type === "live" && (
            <p className="text-xs text-ink-3">
              {t(
                "Requires an external encoder. After delivery, open the Post to retrieve RTMPS credentials and start streaming. Do not attach an Asset.",
              )}
            </p>
          )}
        </div>
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
      visible: true,
    },
  ] as const;
  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-mode`} className="text-xs font-medium text-ink-3">
          {t("Publishing method")}
        </label>
        <Select
          value={tt.post_mode ?? "direct"}
          onValueChange={(value) => update("post_mode", value)}
        >
          <SelectTrigger id={`${fieldId}-mode`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="direct">{t("Direct post")}</SelectItem>
            <SelectItem value="inbox">{t("Send to TikTok inbox")}</SelectItem>
          </SelectContent>
        </Select>
        {tt.post_mode === "inbox" && (
          <p className="text-xs text-ink-3">
            {t(
              "Finish this draft in the TikTok app. Sending to the inbox is not publication. Video captions, visibility, and interactions are chosen in TikTok.",
            )}
          </p>
        )}
      </div>
      {requirements && (
        <p className="text-xs text-ink-2">
          {t("Posting as {name}", { name: requirements.creator.display_name })}
        </p>
      )}
      {(tt.post_mode !== "inbox" || photo) && (
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
      )}
      {tt.post_mode === "inbox" && photo && (
        <label className="flex min-h-12 items-center justify-between gap-3 text-xs text-ink-3">
          {t("AI Generated")}
          <Switch
            checked={tt.is_ai_generated ?? false}
            onCheckedChange={(value) => update("is_ai_generated", value)}
          />
        </label>
      )}
      {tt.post_mode !== "inbox" && (
        <>
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
        </>
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
type InstagramComposerSettings = NonNullable<
  NonNullable<PostTargetDraft["provider_options"]>["instagram"]
>;

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
      <InstagramContentFields
        settings={instagram}
        mediaKinds={mediaKinds}
        update={update}
        updateMany={updateMany}
        t={t}
      />
    </ProviderPanel>
  );
}

/**
 * Selects the actual Page endpoint and its method-specific inputs. External
 * resources use provider IDs, never invented public Post IDs. Switching methods
 * preserves local edits; applyTarget sends only fields for the chosen method.
 */
function FacebookEditor({
  channelName,
  settings,
  update,
  mediaKinds,
  t,
}: ProviderEditorProps<FacebookComposerSettings>): React.ReactElement {
  const id = useId();
  const method =
    settings.post_type ?? (mediaKinds.length === 1 && mediaKinds[0] === "video" ? "reel" : "feed");
  const methods = [
    ["feed", t("Feed: text, link, or photos")],
    ["video", t("Regular video")],
    ["reel", t("Reel")],
    ["story", t("Story")],
    ["slideshow", t("Photo slideshow")],
    ["crosspost", t("Crosspost an existing video")],
    ["ab_test", t("Video A/B test")],
    ["live", t("Live broadcast")],
  ] as const;
  const test = settings.ab_test ?? {};
  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-method`} className="text-xs font-medium text-ink-3">
          {t("Publishing method")}
        </label>
        <Select value={method} onValueChange={(value) => update("post_type", value)}>
          <SelectTrigger id={`${id}-method`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {methods.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!["story", "ab_test", "live"].includes(method) && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-delivery`} className="text-xs font-medium text-ink-3">
            {t("Delivery")}
          </label>
          <Select
            value={settings.delivery_mode ?? "publish"}
            onValueChange={(value) => update("delivery_mode", value)}
          >
            <SelectTrigger id={`${id}-delivery`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="publish">{t("Publish publicly")}</SelectItem>
              <SelectItem value="draft">{t("Save a native Page draft")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {method === "feed" && (
        <div className="flex flex-col gap-3">
          <label htmlFor={`${id}-link`} className="text-xs font-medium text-ink-3">
            {t("Link (optional; no attached photos)")}
          </label>
          <Input
            id={`${id}-link`}
            type="url"
            value={settings.link ?? ""}
            onChange={(event) => update("link", event.target.value)}
            maxLength={2048}
          />
          {(settings.link_cards ?? []).map((card, index) => (
            <fieldset
              key={index}
              className="flex min-w-0 flex-col gap-2 rounded-control border border-line p-3"
            >
              <legend className="text-xs text-ink-3">
                {t("Link card {number}", { number: index + 1 })}
              </legend>
              {(["link", "picture", "name", "description"] as const).map((field) => (
                <label key={field} className="flex flex-col gap-1 text-xs text-ink-3">
                  {
                    {
                      link: t("Destination URL"),
                      picture: t("Image URL"),
                      name: t("Title"),
                      description: t("Description"),
                    }[field]
                  }
                  <Input
                    value={card[field] ?? ""}
                    type={field === "link" || field === "picture" ? "url" : "text"}
                    maxLength={2048}
                    onChange={(event) =>
                      update(
                        "link_cards",
                        settings.link_cards?.map((item, position) =>
                          position === index ? { ...item, [field]: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  update(
                    "link_cards",
                    settings.link_cards?.filter((_, position) => position !== index),
                  )
                }
              >
                {t("Remove card")}
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            disabled={(settings.link_cards?.length ?? 0) >= 5}
            onClick={() =>
              update("link_cards", [...(settings.link_cards ?? []), { link: "", picture: "" }])
            }
          >
            {t("Add link card")}
          </Button>
          <p className="text-xs text-ink-3">
            {t(
              "A link carousel requires two to five cards and a main link. Photo posts use the ordered Assets instead.",
            )}
          </p>
        </div>
      )}
      {method === "crosspost" && (
        <label className="flex flex-col gap-1.5 text-xs text-ink-3">
          {t("Source video ID (crossposting permission required)")}
          <Input
            value={settings.crossposted_video_id ?? ""}
            onChange={(event) => update("crossposted_video_id", event.target.value)}
            maxLength={200}
          />
        </label>
      )}
      {method === "ab_test" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-3">
            {t(
              "Use two to four existing unpublished videos, including the control. This creates a native experiment, not a published winner. Do not attach Assets.",
            )}
          </p>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            {t("Experiment name")}
            <Input
              value={test.name ?? ""}
              maxLength={200}
              onChange={(event) => update("ab_test", { ...test, name: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            {t("Video IDs (comma separated)")}
            <Input
              value={(test.experiment_video_ids ?? []).join(", ")}
              onChange={(event) =>
                update("ab_test", {
                  ...test,
                  experiment_video_ids: event.target.value.split(",").map((value) => value.trim()),
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            {t("Control video ID")}
            <Input
              value={test.control_video_id ?? ""}
              onChange={(event) =>
                update("ab_test", { ...test, control_video_id: event.target.value })
              }
            />
          </label>
          <label htmlFor={`${id}-goal`} className="text-xs text-ink-3">
            {t("Optimization goal")}
          </label>
          <Select
            value={test.optimization_goal ?? ""}
            onValueChange={(value) => update("ab_test", { ...test, optimization_goal: value })}
          >
            <SelectTrigger id={`${id}-goal`}>
              <SelectValue placeholder={t("Choose a goal")} />
            </SelectTrigger>
            <SelectContent>
              {[
                "AVG_TIME_WATCHED",
                "COMMENTS",
                "IMPRESSIONS",
                "IMPRESSIONS_UNIQUE",
                "LINK_CLICKS",
                "REACTIONS",
                "REELS_PLAYS",
                "SHARES",
                "VIDEO_VIEWS_60S",
              ].map((goal) => (
                <SelectItem key={goal} value={goal}>
                  {goal}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            {t("Duration in seconds (1,800–604,800)")}
            <Input
              type="number"
              min={1800}
              max={604800}
              value={test.duration_seconds ?? ""}
              onChange={(event) =>
                update("ab_test", {
                  ...test,
                  duration_seconds:
                    event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
        </div>
      )}
      {method === "slideshow" && (
        <p className="text-xs text-ink-3">{t("Attach three to seven images in playback order.")}</p>
      )}
      {method === "live" && (
        <p className="text-xs text-ink-3">
          {t(
            "Requires an external encoder. After delivery, open the Post to retrieve RTMPS credentials and start streaming. Do not attach an Asset.",
          )}
        </p>
      )}
      {method === "story" && (
        <p className="text-xs text-ink-3">
          {t("Attach one photo or video. Stories do not accept a text caption.")}
        </p>
      )}
      <p className="text-xs text-ink-3">
        {t("Published Page content is public. Native drafts remain unpublished.")}
      </p>
    </ProviderPanel>
  );
}

/** Keeps the canonical provider panel while the Threads module owns its typed content forms. */
function ThreadsEditor(props: ProviderEditorProps<ThreadsComposerSettings>): React.ReactElement {
  return (
    <ProviderPanel channelName={props.channelName} t={props.t}>
      <ThreadsPublishingFields {...props} />
    </ProviderPanel>
  );
}

/**
 * Registry of typed provider descriptors — the single provider boundary for
 * settings narrowing, editor selection, Post target mapping (both directions),
 * and submit-time validation. Provider lookup is by normalized identifier.
 * Captionless methods explicitly clear inherited titles as well as requiring an
 * empty Channel body/signature; hidden Post titles must not become Story text.
 */
const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  defineProviderDescriptor<YouTubeComposerSettings>({
    providers: ["youtube"],
    read: (settings) => settings as Partial<YouTubeComposerSettings>,
    Editor: YoutubeEditor,
    applyTarget: (target, yt) => {
      const title = yt.title?.trim();
      if (title) target.title_override = title;
      const tags = (yt.tags ?? []).map((tag) => tag.label).filter(Boolean);
      if (tags.length > 0) target.hashtags = tags;
      target.provider_options = {
        youtube: {
          ...(yt.post_type ? { post_type: yt.post_type } : {}),
          ...(yt.selfDeclaredMadeForKids !== undefined
            ? { made_for_kids: yt.selfDeclaredMadeForKids === "yes" }
            : {}),
          ...(yt.type ? { privacy_status: yt.type } : {}),
        },
      };
    },
    // Rehydrate the same contract fields the controls save, including false audience.
    readTarget: (target) => {
      const hashtags = target.hashtags ?? [];
      return {
        post_type: target.provider_options?.youtube?.post_type,
        title: target.title_override ?? undefined,
        tags: hashtags.map((tag) => ({ value: tag, label: tag })),
        type: target.provider_options?.youtube?.privacy_status,
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
          ...(tt.post_mode ? { post_mode: tt.post_mode } : {}),
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
          is_ai_generated: tt.is_ai_generated ?? false,
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
        post_mode: options.post_mode,
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
      if (tt.post_mode === "inbox") return [];
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
      if (instagram.post_type === "story") target.title_override = "";
      target.provider_options = {
        instagram: {
          ...(instagram.post_type ? { post_type: instagram.post_type } : {}),
          ...(instagram.content ? { content: instagram.content } : {}),
          ...(instagram.media_options ? { media_options: instagram.media_options } : {}),
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
        content: options.content,
        media_options: options.media_options,
        trial_reel: options.trial_reel,
        trial_graduation: options.trial_graduation,
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
    applyTarget: (target, settings) => {
      const method = settings.post_type;
      if (method === "story") target.title_override = "";
      target.provider_options = {
        facebook: {
          ...(method ? { post_type: method } : {}),
          ...(settings.delivery_mode && !["story", "live", "ab_test"].includes(method ?? "")
            ? { delivery_mode: settings.delivery_mode }
            : {}),
          ...(method === "feed" || !method
            ? {
                ...(settings.link ? { link: settings.link } : {}),
                ...(settings.link_cards?.length ? { link_cards: settings.link_cards } : {}),
              }
            : {}),
          ...(method === "crosspost" && settings.crossposted_video_id
            ? { crossposted_video_id: settings.crossposted_video_id }
            : {}),
          ...(method === "ab_test" && settings.ab_test ? { ab_test: settings.ab_test } : {}),
        },
      };
    },
    readTarget: (target) => target.provider_options?.facebook ?? {},
  }),
  defineProviderDescriptor<ThreadsComposerSettings>({
    providers: ["threads"],
    read: (settings) => settings as Partial<ThreadsComposerSettings>,
    Editor: ThreadsEditor,
    applyTarget: (target, settings, mediaKinds, _requirements, purpose) => {
      target.provider_options = { threads: threadsTargetOptions(settings, mediaKinds, purpose) };
      if (settings.post_type === "repost" || settings.repost_id) target.title_override = "";
    },
    readTarget: (target) => target.provider_options?.threads ?? {},
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
 * Keeps positional Instagram metadata attached to the same Asset as selection
 * and ordering change. The private identity list lives only in composer recovery;
 * descriptors emit just the reordered native metadata, never these UI keys.
 * New Assets get empty metadata; detached Assets cannot donate tags or alt text.
 */
export function settingsForAttachmentOrder(
  settings: Record<string, unknown>,
  assetIds: readonly string[],
): Record<string, unknown> {
  const content = settings.content;
  if (
    !Array.isArray(settings.media_options) &&
    assetIds.length === 1 &&
    content !== null &&
    typeof content === "object" &&
    !Array.isArray(content)
  ) {
    const entries = Object.entries(content);
    const perItem = entries.filter(([key]) => key === "alt_text" || key === "user_tags");
    if (perItem.length)
      settings = {
        ...settings,
        content: Object.fromEntries(
          entries.filter(([key]) => key !== "alt_text" && key !== "user_tags"),
        ),
        media_options: [Object.fromEntries(perItem)],
      };
  }
  if (!Array.isArray(settings.media_options)) return settings;
  const metadata: readonly unknown[] = settings.media_options;
  const previous = settings._instagram_media_asset_ids;
  if (!Array.isArray(previous) || !previous.every((id) => typeof id === "string")) {
    return { ...settings, _instagram_media_asset_ids: [...assetIds] };
  }
  if (previous.length === assetIds.length && previous.every((id, index) => id === assetIds[index]))
    return settings;
  return {
    ...settings,
    _instagram_media_asset_ids: [...assetIds],
    media_options: assetIds.map((id) => metadata[previous.indexOf(id)] ?? {}),
  };
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
  const usesRequirements = descriptor?.usesRequirements === true && settings.post_mode !== "inbox";
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
