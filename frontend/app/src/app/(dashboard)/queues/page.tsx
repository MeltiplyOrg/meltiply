import { useMemo, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Alert } from "@meltiply/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogDescription,
  CenterDialogFooter,
} from "@meltiply/ui/center-dialog";
import {
  CenterAlertDialog,
  CenterAlertDialogContent,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogCancel,
  CenterAlertDialogAction,
} from "@meltiply/ui/center-alert-dialog";
import { useWorkspace } from "@/context/workspace.context";
import { WorkspaceSurface } from "@/components/layout/workspace-surface";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import { useSessionScope } from "@/hooks/use-session-scope";
import {
  useCreateQueue,
  useUpdateQueue,
  useDeleteQueue,
  useQueues,
  useRemovePostFromQueue,
} from "@/lib/queries";
import { useI18n } from "@/lib/i18n";
import { userFacingErrorMessage } from "@/lib/frontend-errors";
import type { PublishingQueue, Post } from "@/types";
import { QueueCalendar } from "@/components/posts/queue-calendar";

/** Localizes the Queue contract's Sunday-zero weekdays without interpreting them in the browser's timezone. */
function queueWeekdayLabels(language: string): string[] {
  const formatter = new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, weekday) =>
    formatter.format(new Date(Date.UTC(2023, 0, 1 + weekday))),
  );
}

/** Focused recurring-plan form composed from canonical CenterDialog, Input and Select owners. Slot rows keep independent identities so removal does not move keyboard focus to another value. */
function QueueEditor({
  queue,
  brandProfileId,
  onSaved,
  open,
  onOpenChange,
}: {
  queue: PublishingQueue | null;
  brandProfileId: string;
  onSaved: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, language } = useI18n();
  const weekdayLabels = useMemo(() => queueWeekdayLabels(language), [language]);
  const scope = useSessionScope();
  const create = useCreateQueue(scope);
  const update = useUpdateQueue(scope);
  const [name, setName] = useState(queue?.name ?? "");
  const [timezone, setTimezone] = useState(
    queue?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [slots, setSlots] = useState(() =>
    (queue?.slots ?? [{ weekday: 1, time: "09:00" }]).map((slot) => ({
      ...slot,
      key: crypto.randomUUID(),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;
  /** Persists the complete validated plan; server errors keep the creator's inputs and the dialog open. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const input = {
      brand_profile_id: brandProfileId,
      name,
      timezone,
      slots: slots.map(({ weekday, time }) => ({ weekday, time })),
    };
    try {
      if (queue) await update.mutateAsync({ id: queue.id, input });
      else await create.mutateAsync(input);
      onSaved();
    } catch (cause) {
      setError(userFacingErrorMessage(cause, language));
    }
  }
  return (
    <CenterDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <CenterDialogContent
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <CenterDialogHeader>
          <CenterDialogTitle>{queue ? t("Edit Queue") : t("Create Queue")}</CenterDialogTitle>
          <CenterDialogDescription>
            {t(
              "Recurring slots assign times automatically. Editing this plan does not move existing reservations.",
            )}
          </CenterDialogDescription>
        </CenterDialogHeader>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="space-y-4"
        >
          <fieldset disabled={busy} className="space-y-4">
            <label className="grid gap-1.5 text-sm">
              {t("Queue name")}
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              {t("Queue timezone")}
              <Input
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                required
                maxLength={100}
              />
            </label>
            <p className="text-xs text-ink-3">
              {t(
                "Use an IANA timezone, for example America/New_York. Nonexistent DST slots are skipped; repeated times use the later occurrence.",
              )}
            </p>
            <div className="space-y-2" role="group" aria-label={t("Weekly slots")}>
              {slots.map((slot, index) => (
                <div key={slot.key} className="flex min-w-0 flex-wrap items-end gap-2">
                  <label className="min-w-32 flex-1 text-xs">
                    {t("Weekday {number}", { number: index + 1 })}
                    <Select
                      value={String(slot.weekday)}
                      onValueChange={(value) =>
                        setSlots((previous) =>
                          previous.map((entry) =>
                            entry.key === slot.key ? { ...entry, weekday: Number(value) } : entry,
                          ),
                        )
                      }
                    >
                      <SelectTrigger aria-label={t("Weekday {number}", { number: index + 1 })}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {weekdayLabels.map((day, weekday) => (
                          <SelectItem key={day} value={String(weekday)}>
                            {day}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="min-w-24 flex-1 text-xs">
                    {t("Slot time {number}", { number: index + 1 })}
                    <Input
                      type="time"
                      required
                      step={60}
                      value={slot.time}
                      onChange={(event) =>
                        setSlots((previous) =>
                          previous.map((entry) =>
                            entry.key === slot.key ? { ...entry, time: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={slots.length === 1}
                    onClick={() =>
                      setSlots((previous) => previous.filter((entry) => entry.key !== slot.key))
                    }
                    aria-label={t("Remove slot {number}", { number: index + 1 })}
                  >
                    {t("Remove")}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={slots.length >= 168}
                onClick={() =>
                  setSlots((previous) => [
                    ...previous,
                    { weekday: 1, time: "09:00", key: crypto.randomUUID() },
                  ])
                }
              >
                <Plus />
                {t("Add slot")}
              </Button>
            </div>
          </fieldset>
          {error && (
            <Alert variant="destructive" role="alert">
              {error}
            </Alert>
          )}
          <CenterDialogFooter>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? t("Saving…") : t("Save Queue")}
            </Button>
          </CenterDialogFooter>
        </form>
      </CenterDialogContent>
    </CenterDialog>
  );
}

type Confirmation =
  | { kind: "delete"; queue: PublishingQueue }
  | { kind: "remove"; queue: PublishingQueue; post: Post };

/** Calendar-first Queue workspace. Admin configuration remains in the compact plan rail; the selected Queue owns its timezone-aware calendar, while the directory confirms safe removal and retirement. */
export default function QueuesPage() {
  const { t, language } = useI18n();
  const weekdayLabels = useMemo(() => queueWeekdayLabels(language), [language]);
  const scope = useSessionScope();
  const scrollRef = useSmoothScrollContainer();
  const {
    brandProfiles,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    canManageConfiguration,
  } = useWorkspace();
  const plans = useQueues(scope, selectedBrandProfileId);
  const queues = plans.data?.pages.flatMap((page) => page.items) ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = queues.find((queue) => queue.id === selectedId) ?? queues[0] ?? null;
  const [editor, setEditor] = useState<{
    queue: PublishingQueue | null;
    key: string;
    brandProfileId: string;
  } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const remove = useRemovePostFromQueue(scope);
  const retire = useDeleteQueue(scope);
  const busy = remove.isPending || retire.isPending;
  /** Commits the confirmed scope only; a lifecycle conflict stays visible without discarding the pending confirmation. */
  async function confirm() {
    if (!confirmation || busy) return;
    setActionError(null);
    try {
      if (confirmation.kind === "delete") {
        await retire.mutateAsync({
          id: confirmation.queue.id,
          brandProfileId: confirmation.queue.brand_profile_id,
        });
        if (selectedId === confirmation.queue.id) setSelectedId(null);
      } else
        await remove.mutateAsync({
          queueId: confirmation.queue.id,
          postId: confirmation.post.id,
          brandProfileId: confirmation.queue.brand_profile_id,
        });
      setConfirmOpen(false);
    } catch (cause) {
      setActionError(userFacingErrorMessage(cause, language));
    }
  }
  return (
    <WorkspaceSurface
      title={t("Queues")}
      description={t("Reusable weekly publishing plans with durable assigned times.")}
      actions={
        canManageConfiguration && (
          <Button
            disabled={!selectedBrandProfileId}
            onClick={() => {
              if (!selectedBrandProfileId) return;
              setEditor({
                queue: null,
                key: crypto.randomUUID(),
                brandProfileId: selectedBrandProfileId,
              });
              setEditorOpen(true);
            }}
          >
            <Plus />
            {t("Create Queue")}
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 pb-3 sm:px-6">
        <Select
          value={selectedBrandProfileId ?? ""}
          onValueChange={(value) => {
            setSelectedBrandProfileId(value);
            setSelectedId(null);
          }}
        >
          <SelectTrigger className="max-w-xs" aria-label={t("Queue Brand Profile")}>
            <SelectValue placeholder={t("Choose a Brand Profile")} />
          </SelectTrigger>
          <SelectContent>
            {brandProfiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          disabled={!selectedBrandProfileId || plans.isFetching}
          onClick={() => {
            void plans.refetch();
          }}
        >
          {t("Refresh")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {!selectedBrandProfileId ? (
          <p>{t("Choose a Brand Profile to inspect its Queues.")}</p>
        ) : plans.isPending ? (
          <p role="status">{t("Loading Queues…")}</p>
        ) : plans.error ? (
          <Alert variant="destructive">{userFacingErrorMessage(plans.error, language)}</Alert>
        ) : queues.length === 0 ? (
          <p>{t("No Queues yet. Create a plan, then choose Queue in the composer.")}</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <section
              aria-label={t("Publishing Queues")}
              ref={scrollRef}
              data-lenis-prevent=""
              className="max-h-52 min-h-0 min-w-0 shrink-0 space-y-3 overflow-y-auto border-b border-line p-3 lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r"
            >
              {queues.map((queue) => (
                <article
                  key={queue.id}
                  className={
                    selected?.id === queue.id
                      ? "space-y-2 rounded-control border border-accent/30 bg-accent-tint p-3"
                      : "space-y-2 rounded-control border border-line p-3"
                  }
                >
                  <h2 className="break-words text-sm font-semibold">{queue.name}</h2>
                  <p className="break-words text-xs text-ink-2">{queue.timezone}</p>
                  <details className="text-xs text-ink-3">
                    <summary className="cursor-pointer">{t("Weekly slots")}</summary>
                    <ul className="mt-1 max-h-40 overflow-auto text-xs text-ink-2">
                      {queue.slots.map((slot) => (
                        <li key={`${slot.weekday}/${slot.time}`}>
                          {t("{day} at {time}", {
                            day: weekdayLabels[slot.weekday]!,
                            time: slot.time,
                          })}
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      aria-pressed={selected?.id === queue.id}
                      onClick={() => {
                        setSelectedId(queue.id);
                      }}
                    >
                      {t("Inspect Posts")}
                    </Button>
                    {canManageConfiguration && (
                      <>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditor({
                              queue,
                              key: crypto.randomUUID(),
                              brandProfileId: queue.brand_profile_id,
                            });
                            setEditorOpen(true);
                          }}
                        >
                          {t("Edit Queue")}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setConfirmation({ kind: "delete", queue });
                            setActionError(null);
                            setConfirmOpen(true);
                          }}
                        >
                          {t("Delete Queue")}
                        </Button>
                      </>
                    )}
                  </div>
                </article>
              ))}
              {plans.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={plans.isFetchingNextPage}
                  onClick={() => {
                    void plans.fetchNextPage();
                  }}
                >
                  {t("Load more Queues")}
                </Button>
              )}
            </section>
            {selected && (
              <QueueCalendar
                key={`${selected.id}:${selected.timezone}`}
                queue={selected}
                onRemove={(post) => {
                  if (!selected) return;
                  setConfirmation({ kind: "remove", queue: selected, post });
                  setActionError(null);
                  setConfirmOpen(true);
                }}
              />
            )}
          </div>
        )}
      </div>
      {editor && (
        <QueueEditor
          key={editor.key}
          queue={editor.queue}
          brandProfileId={editor.brandProfileId}
          onSaved={() => setEditorOpen(false)}
          open={editorOpen}
          onOpenChange={setEditorOpen}
        />
      )}
      <CenterAlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!busy) setConfirmOpen(open);
        }}
      >
        <CenterAlertDialogContent>
          <CenterAlertDialogHeader>
            <CenterAlertDialogTitle>
              {confirmation?.kind === "remove" ? t("Remove from Queue?") : t("Delete Queue?")}
            </CenterAlertDialogTitle>
            <CenterAlertDialogDescription>
              {confirmation?.kind === "remove"
                ? t(
                    "This cancels unclaimed pending Channel delivery and releases its slot. Post text, Assets and settings remain; other reservations do not move.",
                  )
                : t(
                    "Only a Queue with no unresolved Posts can be deleted. Historical membership and Platform outcomes remain unchanged.",
                  )}
            </CenterAlertDialogDescription>
          </CenterAlertDialogHeader>
          {actionError && (
            <Alert variant="destructive" role="alert">
              {actionError}
            </Alert>
          )}
          <CenterAlertDialogFooter>
            <CenterAlertDialogCancel disabled={busy}>{t("Cancel")}</CenterAlertDialogCancel>
            <CenterAlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void confirm();
              }}
            >
              {busy ? t("Working…") : t("Confirm")}
            </CenterAlertDialogAction>
          </CenterAlertDialogFooter>
        </CenterAlertDialogContent>
      </CenterAlertDialog>
    </WorkspaceSurface>
  );
}
