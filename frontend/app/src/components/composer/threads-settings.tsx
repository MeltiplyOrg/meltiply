import { useId } from "react";
import { Input } from "@meltiply/ui/input";
import { Textarea } from "@meltiply/ui/textarea";
import { Button } from "@meltiply/ui/button";
import { Switch } from "@meltiply/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import type { PostTargetInput } from "@/types";
import type { TranslationValues } from "@/lib/i18n";

type Options = NonNullable<NonNullable<PostTargetInput["provider_options"]>["threads"]>;
export type ThreadsComposerSettings = Options;
interface Props {
  settings: Partial<ThreadsComposerSettings>;
  update: (key: string, value: unknown) => void;
  updateMany: (patch: Record<string, unknown>) => void;
  mediaKinds: readonly ("image" | "video")[];
  t: (message: string, values?: TranslationValues) => string;
}

/** Infers the native content form from persisted options, including drafts reopened without a local method key. */
function threadsMethod(
  settings: Partial<ThreadsComposerSettings>,
): NonNullable<ThreadsComposerSettings["post_type"]> {
  return (
    settings.post_type ??
    (settings.repost_id
      ? "repost"
      : settings.poll_attachment
        ? "poll"
        : settings.text_attachment
          ? "long_text"
          : settings.gif_attachment
            ? "gif"
            : settings.is_ghost_post
              ? "ghost"
              : settings.quote_post_id
                ? "quote"
                : settings.reply_to_id
                  ? "reply"
                  : "post")
  );
}

/**
 * Keeps incomplete draft intent and the selected method across reopen. Sending
 * projects only applicable media controls, while the owning composer keeps the
 * unanswered/local values so hidden fields cannot poison a later text target.
 */
export function threadsTargetOptions(
  settings: Partial<ThreadsComposerSettings>,
  mediaKinds: readonly ("image" | "video")[],
  purpose: "draft" | "publication",
): Options {
  const method = threadsMethod(settings);
  if (method === "repost")
    return {
      post_type: method,
      ...(settings.repost_id !== undefined ? { repost_id: settings.repost_id } : {}),
    };
  const {
    post_type: _method,
    repost_id: _repost,
    poll_attachment,
    text_attachment,
    gif_attachment,
    is_ghost_post: _ghost,
    quote_post_id,
    reply_to_id,
    alt_text,
    is_spoiler_media,
    ...common
  } = settings;
  return {
    ...common,
    post_type: method,
    ...(purpose === "draft" || mediaKinds.length ? { alt_text, is_spoiler_media } : {}),
    ...(method === "poll" && poll_attachment ? { poll_attachment } : {}),
    ...(method === "long_text" && text_attachment ? { text_attachment } : {}),
    ...(method === "gif" && gif_attachment ? { gif_attachment } : {}),
    ...(method === "ghost" ? { is_ghost_post: true } : {}),
    ...(method === "quote" && quote_post_id ? { quote_post_id } : {}),
    ...(method === "reply" && reply_to_id ? { reply_to_id } : {}),
  };
}

/**
 * Edits every native Threads content form with typed canonical controls. Caption
 * and ordered Assets remain owned by the composer. Optional permissions and
 * account eligibility are explicit; a cross-share request never substitutes
 * success on Instagram for success on Threads.
 */
export function ThreadsPublishingFields({ settings, update, updateMany, mediaKinds, t }: Props) {
  const id = useId();
  const method = threadsMethod(settings);
  const attachment = settings.text_attachment;
  const methods = [
    ["post", t("Text, image, video, or carousel")],
    ["poll", t("Poll")],
    ["long_text", t("Long-text attachment")],
    ["gif", t("GIF")],
    ["ghost", t("24-hour ghost Post")],
    ["quote", t("Quote a Post")],
    ["reply", t("Reply to a Post")],
    ["repost", t("Repost")],
  ] as const;
  return (
    <>
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
      {["quote", "reply", "repost"].includes(method) && (
        <label className="flex flex-col gap-1.5 text-xs text-ink-3">
          {t("Source Threads Post ID")}
          <Input
            maxLength={200}
            value={
              method === "quote"
                ? (settings.quote_post_id ?? "")
                : method === "reply"
                  ? (settings.reply_to_id ?? "")
                  : (settings.repost_id ?? "")
            }
            onChange={(event) =>
              update(
                method === "quote"
                  ? "quote_post_id"
                  : method === "reply"
                    ? "reply_to_id"
                    : "repost_id",
                event.target.value,
              )
            }
          />
        </label>
      )}
      {method === "repost" ? (
        <p className="text-xs text-ink-3">
          {t(
            "A repost uses only the source Post. Remove the caption, signature, and selected Assets for this Channel.",
          )}
        </p>
      ) : (
        <>
          {["poll", "long_text", "gif", "ghost"].includes(method) && (
            <p className="text-xs text-ink-3">
              {t(
                "This method requires no attached Assets. Keep the main caption within 500 characters.",
              )}
            </p>
          )}
          {method === "poll" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs text-ink-3">
                {t("Poll options (two to four, up to 25 characters each)")}
              </legend>
              {(["option_a", "option_b", "option_c", "option_d"] as const).map((key, index) => (
                <label key={key} className="flex flex-col gap-1 text-xs text-ink-3">
                  {t("Option {number}", { number: index + 1 })}
                  <Input
                    maxLength={25}
                    value={settings.poll_attachment?.[key] ?? ""}
                    onChange={(event) => {
                      const poll = { option_a: "", option_b: "", ...settings.poll_attachment };
                      if (!event.target.value && (key === "option_c" || key === "option_d"))
                        delete poll[key];
                      else poll[key] = event.target.value;
                      update("poll_attachment", poll);
                    }}
                  />
                </label>
              ))}
            </fieldset>
          )}
          {method === "gif" && (
            <label className="flex flex-col gap-1 text-xs text-ink-3">
              {t("GIPHY GIF ID")}
              <Input
                maxLength={200}
                value={settings.gif_attachment?.gif_id ?? ""}
                onChange={(event) =>
                  update("gif_attachment", { provider: "GIPHY", gif_id: event.target.value })
                }
              />
            </label>
          )}
          {method === "long_text" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-ink-3">
                {t("Long text (up to 10,000 characters)")}
                <Textarea
                  rows={8}
                  maxLength={10000}
                  value={attachment?.plaintext ?? ""}
                  onChange={(event) =>
                    update("text_attachment", { ...attachment, plaintext: event.target.value })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-3">
                {t("Long-text link (optional)")}
                <Input
                  type="url"
                  value={attachment?.link_attachment_url ?? ""}
                  onChange={(event) =>
                    update("text_attachment", {
                      ...attachment,
                      plaintext: attachment?.plaintext ?? "",
                      link_attachment_url: event.target.value || undefined,
                    })
                  }
                />
              </label>
              {(attachment?.text_with_styling_info ?? []).map((span, index) => (
                <fieldset
                  key={index}
                  className="grid grid-cols-2 gap-2 rounded-control border border-line p-3"
                >
                  <legend className="text-xs text-ink-3">
                    {t("Styled text range {number}", { number: index + 1 })}
                  </legend>
                  {(["offset", "length"] as const).map((field) => (
                    <label key={field} className="flex flex-col gap-1 text-xs text-ink-3">
                      {field === "offset" ? t("Start offset") : t("Length")}
                      <Input
                        type="number"
                        min={field === "offset" ? 0 : 1}
                        value={span[field]}
                        onChange={(event) =>
                          update("text_attachment", {
                            ...attachment,
                            text_with_styling_info: attachment?.text_with_styling_info?.map(
                              (item, position) =>
                                position === index
                                  ? { ...item, [field]: Number(event.target.value) }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <div className="col-span-2 flex flex-wrap gap-3">
                    {(["bold", "italic", "highlight", "underline", "strikethrough"] as const).map(
                      (style) => (
                        <label key={style} className="flex items-center gap-2 text-xs text-ink-3">
                          <Switch
                            checked={span.styling_info.includes(style)}
                            onCheckedChange={(checked) =>
                              update("text_attachment", {
                                ...attachment,
                                text_with_styling_info: attachment?.text_with_styling_info?.map(
                                  (item, position) =>
                                    position === index
                                      ? {
                                          ...item,
                                          styling_info: checked
                                            ? [...item.styling_info, style]
                                            : item.styling_info.filter((value) => value !== style),
                                        }
                                      : item,
                                ),
                              })
                            }
                          />
                          {style}
                        </label>
                      ),
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="col-span-2"
                    onClick={() =>
                      update("text_attachment", {
                        ...attachment,
                        text_with_styling_info: attachment?.text_with_styling_info?.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    {t("Remove range")}
                  </Button>
                </fieldset>
              ))}
              <Button
                variant="outline"
                disabled={
                  !attachment?.plaintext || (attachment.text_with_styling_info?.length ?? 0) >= 100
                }
                onClick={() =>
                  update("text_attachment", {
                    ...attachment,
                    text_with_styling_info: [
                      ...(attachment?.text_with_styling_info ?? []),
                      { offset: 0, length: 1, styling_info: ["bold"] },
                    ],
                  })
                }
              >
                {t("Add styled range")}
              </Button>
            </>
          )}
          {mediaKinds.length === 0 && method === "post" && (
            <label className="flex flex-col gap-1 text-xs text-ink-3">
              {t("Link attachment (optional)")}
              <Input
                type="url"
                value={settings.link_attachment ?? ""}
                onChange={(event) => update("link_attachment", event.target.value || undefined)}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            {t("Topic tag (optional)")}
            <Input
              maxLength={50}
              value={settings.topic_tag ?? ""}
              onChange={(event) => update("topic_tag", event.target.value || undefined)}
            />
          </label>
          {mediaKinds.length > 0 && (
            <label className="flex flex-col gap-1 text-xs text-ink-3">
              {t("Media alt text")}
              <Textarea
                maxLength={1000}
                value={settings.alt_text ?? ""}
                onChange={(event) => update("alt_text", event.target.value || undefined)}
              />
            </label>
          )}
          <label htmlFor={`${id}-replies`} className="text-xs text-ink-3">
            {t("Who can reply")}
          </label>
          <Select
            value={settings.reply_control ?? "everyone"}
            onValueChange={(value) => update("reply_control", value)}
          >
            <SelectTrigger id={`${id}-replies`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                "everyone",
                "accounts_you_follow",
                "mentioned_only",
                "parent_post_author_only",
                "followers_only",
              ].map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(
            [
              "is_made_with_ai",
              "enable_reply_approvals",
              ...(mediaKinds.length ? ["is_spoiler_media" as const] : []),
            ] as const
          ).map((field) => (
            <label
              key={field}
              className="flex min-h-12 items-center justify-between gap-3 text-xs text-ink-3"
            >
              {
                {
                  is_made_with_ai: t("AI Generated"),
                  enable_reply_approvals: t("Approve replies"),
                  is_spoiler_media: t("Hide media behind a spoiler"),
                }[field]
              }
              <Switch
                checked={settings[field] ?? false}
                onCheckedChange={(value) => update(field, value)}
              />
            </label>
          ))}
          {(settings.text_entities ?? []).map((span, index) => (
            <fieldset
              key={index}
              className="grid grid-cols-2 gap-2 rounded-control border border-line p-3"
            >
              <legend className="text-xs text-ink-3">
                {t("Caption spoiler {number}", { number: index + 1 })}
              </legend>
              {(["offset", "length"] as const).map((field) => (
                <label key={field} className="flex flex-col gap-1 text-xs text-ink-3">
                  {field === "offset" ? t("Start offset") : t("Length")}
                  <Input
                    type="number"
                    min={field === "offset" ? 0 : 1}
                    value={span[field]}
                    onChange={(event) =>
                      update(
                        "text_entities",
                        settings.text_entities?.map((item, position) =>
                          position === index
                            ? { ...item, [field]: Number(event.target.value) }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
              ))}
              <Button
                variant="outline"
                className="col-span-2"
                onClick={() =>
                  update(
                    "text_entities",
                    settings.text_entities?.filter((_, position) => position !== index),
                  )
                }
              >
                {t("Remove range")}
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            disabled={(settings.text_entities?.length ?? 0) >= 10}
            onClick={() =>
              update("text_entities", [
                ...(settings.text_entities ?? []),
                { entity_type: "SPOILER", offset: 0, length: 1 },
              ])
            }
          >
            {t("Add caption spoiler")}
          </Button>
          <details className="text-xs text-ink-3">
            <summary className="cursor-pointer py-2">{t("Account-gated options")}</summary>
            <div className="mt-2 flex flex-col gap-3">
              <p>
                {t(
                  "Location and Instagram cross-sharing require their optional permissions. Country restrictions require an eligible Threads account. The provider may reject unavailable features.",
                )}
              </p>
              <label className="flex flex-col gap-1">
                {t("Location ID")}
                <Input
                  value={settings.location_id ?? ""}
                  onChange={(event) => update("location_id", event.target.value || undefined)}
                />
              </label>
              <label className="flex flex-col gap-1">
                {t("Allowed country codes (comma separated)")}
                <Input
                  value={settings.allowlisted_country_codes?.join(", ") ?? ""}
                  onChange={(event) =>
                    update(
                      "allowlisted_country_codes",
                      event.target.value
                        ? event.target.value
                            .toUpperCase()
                            .split(",")
                            .map((value) => value.trim())
                        : undefined,
                    )
                  }
                />
              </label>
              <label htmlFor={`${id}-cross`}>{t("Share to Instagram Story")}</label>
              <Select
                value={
                  settings.crossreshare_to_ig_dark_mode
                    ? "dark"
                    : settings.crossreshare_to_ig
                      ? "light"
                      : "off"
                }
                onValueChange={(value) =>
                  updateMany({
                    crossreshare_to_ig: value === "light",
                    crossreshare_to_ig_dark_mode: value === "dark",
                  })
                }
              >
                <SelectTrigger id={`${id}-cross`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t("Off")}</SelectItem>
                  <SelectItem value="light">{t("Light")}</SelectItem>
                  <SelectItem value="dark">{t("Dark")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </details>
        </>
      )}
    </>
  );
}
