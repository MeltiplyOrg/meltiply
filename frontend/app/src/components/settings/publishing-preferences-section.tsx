import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import { usePublishingPreferences, useUpdatePublishingPreferences } from "@/lib/queries";
import { QueueTimezonePicker } from "@/components/posts/queue-timezone-picker";
import { toast } from "@meltiply/ui/toast";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Switch } from "@meltiply/ui/switch";
import { Textarea } from "@meltiply/ui/textarea";
import type {
  PublishingPreferences,
  PublishingPreferencesUpdate,
  SignatureTemplate,
} from "@/types";

const MAX_TEMPLATES = 10;

/** Derives a stable display name for one template row's controls. */
function templateFieldId(template: SignatureTemplate, suffix: string): string {
  return `signature-${template.id}-${suffix}`;
}

/**
 * Projects the server document onto the replacement shape the form edits.
 * A whole-document draft keeps timezone, ordered templates, and notification
 * choices atomic, matching the single PUT the form submits.
 *
 * @param data - Current server read, or undefined before it settles.
 * @returns The editable draft, or null when no document has loaded.
 */
function draftOf(data: PublishingPreferences | undefined): PublishingPreferencesUpdate | null {
  return data
    ? {
        notifications: data.notifications,
        signature_templates: data.signature_templates,
        timezone: data.timezone,
      }
    : null;
}

/**
 * Owner preferences for the shared Workspace: the publishing timezone reused by
 * scheduling and displayed dates, reusable signature templates, and the events
 * and channels that may deliver publishing alerts.
 *
 * The form is a whole-document draft because the API replaces timezone,
 * ordered templates, and notification choices atomically. Email is offered only
 * when `email_available` proves the installation can actually deliver mail, so
 * the interface never advertises a channel that cannot work.
 */
export function PublishingPreferencesSection(): React.ReactElement {
  const { t } = useI18n();
  const scope = useSessionScope();
  const query = usePublishingPreferences(scope);
  const update = useUpdatePublishingPreferences(scope);
  const [edited, setEdited] = useState<{
    source: typeof query.data;
    value: PublishingPreferencesUpdate;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const browserTimeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const draft: PublishingPreferencesUpdate | null =
    edited && edited.source === query.data ? edited.value : draftOf(query.data);

  /**
   * Applies one local edit against the current server-backed draft. A new query
   * result supersedes local edits because its object identity differs, so a
   * successful save or an external refresh is shown without an effect.
   */
  function setDraft(
    updater: (current: PublishingPreferencesUpdate | null) => PublishingPreferencesUpdate | null,
  ) {
    setEdited((previous) => {
      const base =
        previous && previous.source === query.data ? previous.value : draftOf(query.data);
      const next = updater(base);
      return next !== null && query.data ? { source: query.data, value: next } : previous;
    });
  }

  if (query.error) {
    return <Alert variant="destructive">{t("Publishing preferences could not be loaded.")}</Alert>;
  }
  if (query.isPending || draft === null) {
    return (
      <p role="status" className="text-sm text-ink-2">
        {t("Loading publishing preferences…")}
      </p>
    );
  }

  const emailAvailable = query.data?.email_available ?? false;
  const usesDeviceTimeZone = draft.timezone === null;
  const displayTimeZone = draft.timezone ?? browserTimeZone;

  /** Replaces one template row while preserving order and a single default. */
  function patchTemplate(index: number, patch: Partial<SignatureTemplate>) {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            signature_templates: current.signature_templates.map((template, position) =>
              position === index ? { ...template, ...patch } : template,
            ),
          },
    );
  }

  /** Moves one template row so the submitted list is the display order. */
  function moveTemplate(index: number, direction: -1 | 1) {
    setDraft((current) => {
      if (current === null) return current;
      const target = index + direction;
      if (target < 0 || target >= current.signature_templates.length) return current;
      const templates = [...current.signature_templates];
      const [moved] = templates.splice(index, 1);
      if (!moved) return current;
      templates.splice(target, 0, moved);
      return { ...current, signature_templates: templates };
    });
  }

  /** Removes one template; deleting the default promotes the first remaining row. */
  function removeTemplate(index: number) {
    setDraft((current) => {
      if (current === null) return current;
      const removed = current.signature_templates[index];
      const templates = current.signature_templates.filter((_, position) => position !== index);
      if (removed?.is_default && templates[0]) {
        templates[0] = { ...templates[0], is_default: true };
      }
      return { ...current, signature_templates: templates };
    });
  }

  /** Appends a blank template, selecting it as default when it is the first. */
  function addTemplate() {
    setDraft((current) => {
      if (current === null || current.signature_templates.length >= MAX_TEMPLATES) return current;
      const template: SignatureTemplate = {
        body: "",
        id: crypto.randomUUID(),
        is_default: current.signature_templates.length === 0,
        name: "",
        position: current.signature_templates.length,
      };
      return { ...current, signature_templates: [...current.signature_templates, template] };
    });
  }

  /** Persists the complete draft; positions are rewritten to display order. */
  async function save() {
    if (draft === null || saving) return;
    setSaving(true);
    try {
      const templates = draft.signature_templates.map((template, position) => ({
        ...template,
        position,
      }));
      await update.mutateAsync({
        notifications: {
          ...draft.notifications,
          channels: {
            email: emailAvailable ? draft.notifications.channels.email : false,
          },
        },
        signature_templates: templates,
        timezone: draft.timezone,
      });
      toast(t("Publishing preferences saved"), {
        description: t("Scheduling and displayed dates now use these choices."),
        variant: "success",
      });
    } catch (cause) {
      toast(t("Publishing preferences could not be saved"), {
        description: cause instanceof Error ? cause.message : t("Try again in a moment."),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-8" aria-label={t("Publishing preferences")}>
      <div className="space-y-4">
        <div>
          <h2 className="text-(length:--font-size-ui) font-semibold">{t("Publishing timezone")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            {t(
              "New schedules interpret wall-clock input in this timezone. Existing schedules keep their stored instant.",
            )}
          </p>
        </div>
        <label className="flex min-h-11 items-center justify-between gap-4 rounded-control border border-line px-3 py-2">
          <span className="text-sm">{t("Use this device's timezone")}</span>
          <Switch
            aria-label={t("Use this device's timezone")}
            checked={usesDeviceTimeZone}
            onCheckedChange={(checked) =>
              setDraft((current) =>
                current === null
                  ? current
                  : { ...current, timezone: checked ? null : displayTimeZone },
              )
            }
          />
        </label>
        {!usesDeviceTimeZone && (
          <QueueTimezonePicker
            value={displayTimeZone}
            label={t("Publishing timezone")}
            disabled={saving}
            onChange={(timezone) =>
              setDraft((current) => (current === null ? current : { ...current, timezone }))
            }
          />
        )}
        <p className="text-xs text-ink-3">
          {t(
            "Spring-forward gaps move forward by the missing hour; repeated fall-back times use the earlier occurrence.",
          )}
        </p>
      </div>

      <div className="space-y-4 border-t border-line pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-(length:--font-size-ui) font-semibold">{t("Signatures")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">
              {t(
                "Signatures are appended to new Posts. Use {brand_profile}, {platform}, and {channel} placeholders; saved Posts keep the signature they stored.",
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || draft.signature_templates.length >= MAX_TEMPLATES}
            onClick={addTemplate}
          >
            <Plus className="size-4" />
            {t("Add signature")}
          </Button>
        </div>
        {draft.signature_templates.length === 0 ? (
          <p className="text-sm text-ink-3">{t("No signatures configured.")}</p>
        ) : (
          <ol className="space-y-4">
            {draft.signature_templates.map((template, index) => (
              <li
                key={template.id}
                className="space-y-3 rounded-card border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                    <label
                      htmlFor={templateFieldId(template, "name")}
                      className="text-xs font-medium text-ink-3"
                    >
                      {t("Template name")}
                    </label>
                    <Input
                      id={templateFieldId(template, "name")}
                      value={template.name}
                      maxLength={80}
                      disabled={saving}
                      onChange={(event) => patchTemplate(index, { name: event.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={template.is_default ? "secondary" : "outline"}
                    aria-pressed={template.is_default}
                    disabled={saving}
                    onClick={() =>
                      setDraft((current) =>
                        current === null
                          ? current
                          : {
                              ...current,
                              signature_templates: current.signature_templates.map(
                                (candidate, position) => ({
                                  ...candidate,
                                  is_default: position === index,
                                }),
                              ),
                            },
                      )
                    }
                  >
                    {t("Default")}
                  </Button>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Move signature up")}
                      disabled={saving || index === 0}
                      onClick={() => moveTemplate(index, -1)}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Move signature down")}
                      disabled={saving || index === draft.signature_templates.length - 1}
                      onClick={() => moveTemplate(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("Delete signature")}
                      disabled={saving}
                      onClick={() => removeTemplate(index)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={templateFieldId(template, "body")}
                    className="text-xs font-medium text-ink-3"
                  >
                    {t("Signature text")}
                  </label>
                  <Textarea
                    id={templateFieldId(template, "body")}
                    value={template.body}
                    maxLength={1000}
                    rows={3}
                    disabled={saving}
                    placeholder={t("Follow {brand_profile} on {platform}: {channel}")}
                    onChange={(event) => patchTemplate(index, { body: event.target.value })}
                  />
                  <span className="self-end text-(length:--font-size-micro) text-ink-3">
                    {template.body.length}/1000
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="space-y-4 border-t border-line pt-6">
        <div>
          <h2 className="text-(length:--font-size-ui) font-semibold">{t("Notifications")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">
            {t(
              "Delivery is durable and retried. An untouched installation sends nothing until you enable an event.",
            )}
          </p>
        </div>
        <div className="space-y-2">
          {(
            [
              ["publication_failed", t("Publication failed")],
              ["channel_disconnected", t("Channel needs reconnecting")],
            ] as const
          ).map(([event, label]) => (
            <label
              key={event}
              className="flex min-h-11 items-center justify-between gap-4 rounded-control border border-line px-3 py-2"
            >
              <span className="text-sm">{label}</span>
              <Switch
                aria-label={label}
                checked={draft.notifications.events[event]}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          notifications: {
                            ...current.notifications,
                            events: { ...current.notifications.events, [event]: checked },
                          },
                        },
                  )
                }
              />
            </label>
          ))}
          <label className="flex min-h-11 items-center justify-between gap-4 rounded-control border border-line px-3 py-2">
            <span className="text-sm">
              {t("Email")}
              <span className="block text-xs text-ink-3">
                {emailAvailable
                  ? t("Send alerts to the Installation Owner's email.")
                  : t("Email delivery is not configured for this installation.")}
              </span>
            </span>
            <Switch
              aria-label={t("Email notifications")}
              checked={draft.notifications.channels.email}
              disabled={saving || !emailAvailable}
              onCheckedChange={(checked) =>
                setDraft((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        notifications: {
                          ...current.notifications,
                          channels: { email: checked },
                        },
                      },
                )
              }
            />
          </label>
        </div>
      </div>

      <div className="flex justify-end border-t border-line pt-4">
        <Button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? t("Saving…") : t("Save preferences")}
        </Button>
      </div>
    </section>
  );
}
