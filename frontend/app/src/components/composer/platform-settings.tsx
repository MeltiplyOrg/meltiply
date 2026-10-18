import React, { useEffect, useId } from "react";
import { Input } from "@meltiply/ui/input";
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
  brand_content?: boolean;
  brand_organic?: boolean;
  is_ai_generated?: boolean;
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
  /** Live TikTok publishing requirements when the descriptor opted in; otherwise null. */
  requirements: TikTokPublishingRequirements | null;
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
  /** Maps typed settings onto a saved Post target; omit when the provider emits no contract fields. */
  applyTarget?: (target: PostTargetDraft, settings: Partial<S>) => void;
  /**
   * Rebuilds the raw settings map from a persisted Post target so an edited
   * post rehydrates its provider controls. Fields the provider does not write
   * (or wrote as `null`) yield an empty map and therefore the control defaults.
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
  applyTarget?: (target: PostTargetDraft, settings: Record<string, unknown>) => void;
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
      requirements={props.requirements}
      t={props.t}
    />
  );
  return {
    providers: spec.providers,
    usesRequirements: spec.usesRequirements,
    read,
    Editor: ErasedEditor,
    applyTarget: applyTarget
      ? (target, settings) => applyTarget(target, read(settings))
      : undefined,
    readTarget: readTarget ? (target) => ({ ...readTarget(target) }) : undefined,
    validate: validate
      ? (context) => validate({ ...context, settings: read(context.settings) })
      : undefined,
  };
}

/**
 * Static TikTok privacy levels used as a fallback while the creator's live
 * publishing requirements are loading (or unavailable for the account).
 */
const FALLBACK_TIKTOK_PRIVACY_LEVELS: TikTokPrivacyLevel[] = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

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
 * YouTube settings editor: video title (contract `title_override`) and
 * comma-separated tags (contract `hashtags`). Both are the only fields this
 * provider writes, and both round-trip through the Post target.
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
      </div>
    </ProviderPanel>
  );
}

/**
 * TikTok settings editor: post title, creator-scoped privacy level, interaction
 * toggles (duet/stitch/comments gated by live requirements), and disclosure flags.
 *
 * Live `PublishingRequirements` drive the selectable privacy levels and whether
 * the interaction toggles are offered; the static list is the loading fallback.
 * Every switch shares one responsive grid and a full-row label/touch target.
 */
function TikTokEditor({
  channelName,
  settings: tt,
  update,
  requirements,
  t,
}: ProviderEditorProps<TikTokComposerSettings>): React.ReactElement {
  const fieldId = useId();
  const privacyLevels = requirements?.privacy_levels ?? FALLBACK_TIKTOK_PRIVACY_LEVELS;
  const selectableLevels =
    tt.privacy_level && !privacyLevels.includes(tt.privacy_level)
      ? [...privacyLevels, tt.privacy_level]
      : privacyLevels;
  const privacyLabels: Record<TikTokPrivacyLevel, string> = {
    PUBLIC_TO_EVERYONE: t("Public to Everyone"),
    MUTUAL_FOLLOW_FRIENDS: t("Friends Only"),
    FOLLOWER_OF_CREATOR: t("Followers"),
    SELF_ONLY: t("Private (Self Only)"),
  };
  const toggles = [
    {
      field: "duet",
      label: t("Duet"),
      checked: tt.duet ?? true,
      disabled: requirements?.duet_allowed === false,
    },
    {
      field: "stitch",
      label: t("Stitch"),
      checked: tt.stitch ?? true,
      disabled: requirements?.stitch_allowed === false,
    },
    {
      field: "comment",
      label: t("Comments"),
      checked: tt.comment ?? true,
      disabled: requirements?.comment_allowed === false,
    },
    {
      field: "brand_content",
      label: t("Brand Content"),
      checked: tt.brand_content ?? false,
      disabled: false,
    },
    {
      field: "brand_organic",
      label: t("Organic Brand"),
      checked: tt.brand_organic ?? false,
      disabled: false,
    },
    {
      field: "is_ai_generated",
      label: t("AI Generated"),
      checked: tt.is_ai_generated ?? false,
      disabled: false,
    },
  ] as const satisfies ReadonlyArray<{
    field: keyof TikTokComposerSettings;
    label: string;
    checked: boolean;
    disabled: boolean;
  }>;

  return (
    <ProviderPanel channelName={channelName} t={t}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-title`} className="text-xs font-medium text-ink-3">
          {t("Post Title (optional, max 90 characters)")}
        </label>
        <Input
          id={`${fieldId}-title`}
          placeholder={t("TikTok post title...")}
          value={tt.title ?? ""}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => update("title", e.target.value)}
          maxLength={90}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${fieldId}-privacy`} className="text-xs font-medium text-ink-3">
          {t("Privacy Level")}
        </label>
        <Select
          value={tt.privacy_level ?? ""}
          onValueChange={(val: string) => update("privacy_level", val)}
        >
          <SelectTrigger id={`${fieldId}-privacy`}>
            <SelectValue placeholder={t("Select privacy")} />
          </SelectTrigger>
          <SelectContent>
            {selectableLevels.map((level) => (
              <SelectItem key={level} value={level}>
                {privacyLabels[level] ?? level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-x-6 @sm:grid-cols-2">
        {toggles.map((toggle) => (
          <label
            key={toggle.field}
            htmlFor={`${fieldId}-${toggle.field}`}
            className="flex min-h-12 min-w-0 cursor-pointer items-center justify-between gap-3 py-2 has-[:disabled]:cursor-not-allowed"
          >
            <span className="min-w-0 text-xs font-medium text-ink">{toggle.label}</span>
            <Switch
              id={`${fieldId}-${toggle.field}`}
              checked={toggle.checked}
              disabled={toggle.disabled}
              onCheckedChange={(checked) => update(toggle.field, checked)}
            />
          </label>
        ))}
      </div>
    </ProviderPanel>
  );
}

/**
 * Threads settings editor: informational panel only — Threads posts use the
 * standard text and attached media with no provider-specific controls.
 */
function ThreadsEditor({ t }: ProviderEditorProps<Record<string, never>>): React.ReactElement {
  return (
    <div className="rounded-control border border-line bg-surface p-4 text-xs text-ink-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span>{t("Uses standard text and attached media.")}</span>
      </div>
    </div>
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
    },
    // Rebuilds the YouTube controls from the persisted target: `title_override`
    // and `hashtags` are the only fields this provider writes.
    readTarget: (target) => {
      const hashtags = target.hashtags ?? [];
      return {
        title: target.title_override ?? undefined,
        tags: hashtags.map((tag) => ({ value: tag, label: tag })),
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
    applyTarget: (target, tt) => {
      const title = tt.title?.trim();
      if (title) target.title_override = title;
      target.provider_options = {
        tiktok: {
          // Validated non-empty before submit; the fallback only satisfies the type.
          privacy_level: tt.privacy_level ?? "PUBLIC_TO_EVERYONE",
          allow_comment: tt.comment ?? true,
          allow_duet: tt.duet ?? true,
          allow_stitch: tt.stitch ?? true,
          brand_content: tt.brand_content ?? false,
          brand_organic: tt.brand_organic ?? false,
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
        privacy_level: options.privacy_level,
        comment: options.allow_comment,
        duet: options.allow_duet,
        stitch: options.allow_stitch,
        brand_content: options.brand_content,
        brand_organic: options.brand_organic,
        is_ai_generated: options.is_ai_generated,
      };
    },
    validate: ({ channelName, settings: tt, requirements, t }) => {
      const errors: string[] = [];
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
        if ((tt.comment ?? true) && !requirements.comment_allowed) {
          errors.push(
            t("{name}: comments are not allowed for this creator.", { name: channelName }),
          );
        }
        if ((tt.duet ?? true) && !requirements.duet_allowed) {
          errors.push(t("{name}: duet is not allowed for this creator.", { name: channelName }));
        }
        if ((tt.stitch ?? true) && !requirements.stitch_allowed) {
          errors.push(t("{name}: stitch is not allowed for this creator.", { name: channelName }));
        }
      }
      return errors;
    },
  }),
  defineProviderDescriptor<Record<string, never>>({
    providers: ["threads"],
    read: () => ({}),
    Editor: ThreadsEditor,
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
 * than in this component. Only a subset of settings persist through the Post
 * target — TikTok options map to `provider_options.tiktok`, YouTube title/tags
 * map to `title_override`/`hashtags`. Every control in a descriptor's editor is
 * persisted by its `applyTarget`, and the descriptor's `readTarget` performs the
 * reverse mapping when an edited post rehydrates these controls.
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
    requirementsQuery.data && requirementsQuery.data.platform === "tiktok"
      ? requirementsQuery.data
      : null;

  // Report live requirements upward so the composer can validate submissions
  // even for channels whose settings tab was never opened after data arrived.
  useEffect(() => {
    onRequirementsChange?.(channelId, usesRequirements ? requirements : null);
  }, [channelId, usesRequirements, requirements, onRequirementsChange]);

  if (!descriptor) return null;

  // Merges one key into the raw settings map and reports the change upward.
  const update = (key: string, value: unknown) => {
    onChange({
      ...settings,
      [key]: value,
    });
  };

  const Editor = descriptor.Editor;
  return (
    <Editor
      channelName={channelName}
      settings={settings}
      update={update}
      requirements={requirements}
      t={t}
    />
  );
}
