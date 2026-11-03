import { Input } from "@meltiply/ui/input";
import { Textarea } from "@meltiply/ui/textarea";
import { Button } from "@meltiply/ui/button";
import { Switch } from "@meltiply/ui/switch";
import type { PostTargetInput } from "@/types";
import type { TranslationValues } from "@/lib/i18n";

type Options = NonNullable<NonNullable<PostTargetInput["provider_options"]>["instagram"]>;
type Content = NonNullable<Options["content"]>;
interface Props {
  settings: Options;
  mediaKinds: readonly ("image" | "video")[];
  update: (key: string, value: unknown) => void;
  updateMany: (patch: Record<string, unknown>) => void;
  t: (message: string, values?: TranslationValues) => string;
}

/**
 * Exposes Instagram-Login metadata on its actual owning container. Per-item alt
 * text and tags preserve the selected attachment order; Story controls contain
 * mentions only. Draft edits remain raw until the publication boundary validates
 * provider identifiers, at most three collaborators, HTTPS URLs, coordinates,
 * and format compatibility.
 */
export function InstagramContentFields({ settings, mediaKinds, update, updateMany, t }: Props) {
  const method =
    settings.post_type ?? (mediaKinds.length === 1 && mediaKinds[0] === "video" ? "reel" : "feed");
  const content = settings.content ?? {};
  const carousel = mediaKinds.length > 1;
  /** Replaces one container's metadata while retaining every other attachment's current edit. */
  function save(metadata: Content, index?: number) {
    if (index === undefined) update("content", metadata);
    else {
      const { alt_text: _alt, user_tags: _tags, ...parent } = content;
      updateMany({
        ...(mediaKinds.length === 1 ? { content: parent } : {}),
        media_options: mediaKinds.map((_, position) =>
          position === index ? metadata : (settings.media_options?.[position] ?? {}),
        ),
      });
    }
  }
  /** Renders tags for a single container; image-feed coordinates are explicit normalized values. */
  function tags(metadata: Content, kind: "image" | "video" | undefined, index?: number) {
    return (
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-xs text-ink-3">{t("User mentions and tags")}</legend>
        {(metadata.user_tags ?? []).map((tag, position) => (
          <div
            key={position}
            className="flex min-w-0 flex-col gap-2 rounded-control border border-line p-3"
          >
            <label className="flex flex-col gap-1 text-xs text-ink-3">
              {t("Instagram username")}
              <Input
                maxLength={30}
                value={tag.username}
                onChange={(event) =>
                  save(
                    {
                      ...metadata,
                      user_tags: metadata.user_tags?.map((item, row) =>
                        row === position ? { ...item, username: event.target.value } : item,
                      ),
                    },
                    index,
                  )
                }
              />
            </label>
            {kind === "image" && method !== "story" && (
              <div className="grid grid-cols-2 gap-2">
                {(["x", "y"] as const).map((coordinate) => (
                  <label key={coordinate} className="flex flex-col gap-1 text-xs text-ink-3">
                    {coordinate === "x"
                      ? t("Horizontal position (0–1)")
                      : t("Vertical position (0–1)")}
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={tag[coordinate] ?? ""}
                      onChange={(event) =>
                        save(
                          {
                            ...metadata,
                            user_tags: metadata.user_tags?.map((item, row) =>
                              row === position
                                ? {
                                    ...item,
                                    [coordinate]:
                                      event.target.value === ""
                                        ? undefined
                                        : Number(event.target.value),
                                  }
                                : item,
                            ),
                          },
                          index,
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              onClick={() =>
                save(
                  {
                    ...metadata,
                    user_tags: metadata.user_tags?.filter((_, row) => row !== position),
                  },
                  index,
                )
              }
            >
              {t("Remove tag")}
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={(metadata.user_tags?.length ?? 0) >= 20}
          onClick={() =>
            save(
              { ...metadata, user_tags: [...(metadata.user_tags ?? []), { username: "" }] },
              index,
            )
          }
        >
          {t("Add user tag")}
        </Button>
      </fieldset>
    );
  }
  return (
    <details className="text-xs text-ink-3">
      <summary className="cursor-pointer py-2">{t("Instagram content options")}</summary>
      <div className="mt-3 flex flex-col gap-4">
        {method === "story" ? (
          <p>
            {t(
              "Stories do not accept a caption or signature. Use an empty caption override and no signature for this Channel.",
            )}
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              {t("Collaborator usernames (up to three, comma separated)")}
              <Input
                value={content.collaborators?.join(", ") ?? ""}
                onChange={(event) =>
                  save({
                    ...content,
                    collaborators: event.target.value
                      ? event.target.value.split(",").map((name) => name.trim())
                      : undefined,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              {t("Facebook location ID (optional)")}
              <Input
                value={content.location_id ?? ""}
                onChange={(event) =>
                  save({ ...content, location_id: event.target.value || undefined })
                }
              />
            </label>
            <label className="flex min-h-12 items-center justify-between gap-3">
              {t("AI Generated")}
              <Switch
                checked={content.is_ai_generated ?? false}
                onCheckedChange={(value) => save({ ...content, is_ai_generated: value })}
              />
            </label>
            {method === "reel" && (
              <>
                <label className="flex min-h-12 items-center justify-between gap-3">
                  {t("Also share Reel to feed")}
                  <Switch
                    checked={content.share_to_feed ?? true}
                    onCheckedChange={(value) => save({ ...content, share_to_feed: value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {t("Reel cover image URL (JPEG, optional)")}
                  <Input
                    type="url"
                    value={content.cover_url ?? ""}
                    onChange={(event) =>
                      save({ ...content, cover_url: event.target.value || undefined })
                    }
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {t("Original audio name (optional)")}
                  <Input
                    maxLength={255}
                    value={content.audio_name ?? ""}
                    onChange={(event) =>
                      save({ ...content, audio_name: event.target.value || undefined })
                    }
                  />
                </label>
              </>
            )}
            {!carousel && mediaKinds[0] === "video" && (
              <label className="flex flex-col gap-1">
                {t("Thumbnail offset in milliseconds (optional)")}
                <Input
                  type="number"
                  min={0}
                  value={content.thumb_offset ?? ""}
                  onChange={(event) =>
                    save({
                      ...content,
                      thumb_offset:
                        event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
            )}
          </>
        )}
        {mediaKinds.map((kind, index) => {
          const metadata =
            settings.media_options?.[index] ??
            (mediaKinds.length === 1
              ? {
                  ...(content.alt_text !== undefined ? { alt_text: content.alt_text } : {}),
                  ...(content.user_tags !== undefined ? { user_tags: content.user_tags } : {}),
                }
              : {});
          return (
            <fieldset
              key={index}
              className="flex min-w-0 flex-col gap-3 rounded-control border border-line p-3"
            >
              <legend>{t("Attachment {number}", { number: index + 1 })}</legend>
              {method !== "story" && kind === "image" && (
                <label className="flex flex-col gap-1">
                  {t("Image alt text")}
                  <Textarea
                    maxLength={1000}
                    value={metadata.alt_text ?? ""}
                    onChange={(event) =>
                      save({ ...metadata, alt_text: event.target.value || undefined }, index)
                    }
                  />
                </label>
              )}
              {tags(metadata, kind, index)}
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
