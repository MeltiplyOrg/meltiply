import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { CalendarClock, MoreHorizontal, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Alert } from "@meltiply/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { SidebarGlideHighlight } from "@meltiply/ui/sidebar-glide-highlight";
import { cn } from "@meltiply/ui/utils";
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
import { TimeOfDayField } from "@/components/posts/time-of-day-field";
import { QueueTimezonePicker } from "@/components/posts/queue-timezone-picker";

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
  const [timezonePanelOpen, setTimezonePanelOpen] = useState(false);
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
        closeLabel={t("Close")}
        onEscapeKeyDown={(event) => {
          // The timezone panel owns Escape while open; Radix listens on the
          // document, so the dialog must decline the same keypress.
          if (busy || timezonePanelOpen) event.preventDefault();
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
            <QueueTimezonePicker
              value={timezone}
              onChange={setTimezone}
              onOpenChange={setTimezonePanelOpen}
              disabled={busy}
            />
            <p className="text-xs text-ink-3">
              {t(
                "Use an IANA timezone, for example America/New_York. Nonexistent DST slots are skipped; repeated times use the later occurrence.",
              )}
            </p>
            <div className="space-y-2" role="group" aria-label={t("Weekly slots")}>
              <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-1">
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
                    <div className="min-w-28 flex-1">
                      <TimeOfDayField
                        label={t("Slot time {number}", { number: index + 1 })}
                        value={slot.time}
                        disabled={busy}
                        required
                        onChange={(time) =>
                          setSlots((previous) =>
                            previous.map((entry) =>
                              entry.key === slot.key ? { ...entry, time } : entry,
                            ),
                          )
                        }
                      />
                    </div>
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
              </div>
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

/** Queue configuration menu shared by the desktop rail and compact phone selector. Callers retain editor/confirmation state and render it only for authorized administrators; selecting an action never changes the active Queue. */
function QueueActions({
  queue,
  onEdit,
  onDelete,
}: {
  queue: PublishingQueue;
  onEdit: (queue: PublishingQueue) => void;
  onDelete: (queue: PublishingQueue) => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-glide-ignore=""
          className="relative z-10 size-8 shrink-0"
          aria-label={t("Actions for {name}", { name: queue.name })}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(queue)}>
          <Pencil className="size-3.5" />
          {t("Edit Queue")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-red focus:text-red" onSelect={() => onDelete(queue)}>
          <Trash2 className="size-3.5" />
          {t("Delete Queue")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Confirmation =
  | { kind: "delete"; queue: PublishingQueue }
  | { kind: "remove"; queue: PublishingQueue; post: Post };

/** Calendar-first Queue workspace. Admin configuration remains in the compact plan rail; the selected Queue owns its timezone-aware calendar, while the directory confirms safe removal and retirement. */
export default function QueuesPage() {
  const { t, language } = useI18n();
  const scope = useSessionScope();
  const scrollRef = useSmoothScrollContainer();
  const queueListRef = useRef<HTMLDivElement>(null);
  const {
    brandProfiles,
    selectedBrandProfileId,
    setSelectedBrandProfileId,
    canManageConfiguration,
    isLoading: workspaceLoading,
  } = useWorkspace();
  // Queue configuration always has one owner, without changing the workspace's
  // aggregate selection merely because this route supplies its initial default.
  const activeProfileId =
    brandProfiles.find((profile) => profile.id === selectedBrandProfileId)?.id ??
    brandProfiles[0]?.id ??
    null;
  const plans = useQueues(scope, activeProfileId);
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
  /** Opens an identity-keyed editor without discarding another Queue's persisted configuration. */
  function editQueue(queue: PublishingQueue) {
    setEditor({ queue, key: crypto.randomUUID(), brandProfileId: queue.brand_profile_id });
    setEditorOpen(true);
  }
  /** Opens the existing destructive confirmation; no retirement occurs until confirmed. */
  function deleteQueue(queue: PublishingQueue) {
    setConfirmation({ kind: "delete", queue });
    setActionError(null);
    setConfirmOpen(true);
  }
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
      description={
        <span className="hidden sm:inline">
          {t("Reusable weekly publishing plans with durable assigned times.")}
        </span>
      }
      actions={
        canManageConfiguration && (
          <Button
            disabled={!activeProfileId}
            onClick={() => {
              if (!activeProfileId) return;
              setEditor({
                queue: null,
                key: crypto.randomUUID(),
                brandProfileId: activeProfileId,
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 pb-3 sm:px-6">
          <Select
            value={activeProfileId ?? ""}
            onValueChange={(value) => {
              setSelectedBrandProfileId(value);
              setSelectedId(null);
            }}
          >
            <SelectTrigger
              className="min-w-0 flex-1 sm:max-w-xs"
              aria-label={t("Queue Brand Profile")}
            >
              <SelectValue placeholder={t("Brand Profiles")} />
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
            aria-label={t("Refresh")}
            disabled={!activeProfileId || plans.isFetching}
            onClick={() => {
              void plans.refetch();
            }}
          >
            <RotateCw className="size-4" />
            <span className="hidden sm:inline">{t("Refresh")}</span>
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {!activeProfileId ? (
            <div className="p-4 sm:p-6">
              {workspaceLoading ? (
                <p role="status">{t("Loading Queues…")}</p>
              ) : (
                <Alert>
                  {t(
                    "No Brand Profiles yet. Ask a workspace admin to create one, or use Create Brand Profile if you are an admin.",
                  )}
                  {canManageConfiguration && (
                    <Button asChild variant="outline" className="mt-3">
                      <Link to="/channels">{t("Channels")}</Link>
                    </Button>
                  )}
                </Alert>
              )}
            </div>
          ) : plans.isPending ? (
            <p className="p-4 sm:p-6" role="status">
              {t("Loading Queues…")}
            </p>
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
                className="max-h-52 min-h-0 min-w-0 shrink-0 overflow-y-auto border-b border-line px-4 py-2 lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r lg:px-2.5 lg:py-4"
              >
                <h2 className="hidden px-2 pb-2 text-(length:--font-size-micro) font-semibold uppercase tracking-wide text-ink-3 lg:block">
                  {t("Publishing Queues")}
                </h2>
                {selected && (
                  <div className="flex min-w-0 items-center gap-2 lg:hidden">
                    <Select value={selected.id} onValueChange={setSelectedId}>
                      <SelectTrigger className="min-w-0 flex-1" aria-label={t("Choose a Queue")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {queues.map((queue) => (
                          <SelectItem key={queue.id} value={queue.id}>
                            {queue.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {canManageConfiguration && (
                      <QueueActions queue={selected} onEdit={editQueue} onDelete={deleteQueue} />
                    )}
                  </div>
                )}
                <div ref={queueListRef} className="relative hidden space-y-1 lg:block">
                  <SidebarGlideHighlight containerRef={queueListRef} snapThreshold={12} />
                  {queues.map((queue) => (
                    <div key={queue.id} className="relative flex min-w-0 items-center gap-1">
                      <Button
                        variant={selected?.id === queue.id ? "secondary" : "ghost"}
                        data-sidebar-item=""
                        aria-label={queue.name}
                        aria-pressed={selected?.id === queue.id}
                        onClick={() => setSelectedId(queue.id)}
                        className={cn(
                          "relative z-10 h-auto min-h-11 min-w-0 flex-1 justify-start gap-2.5 px-2 py-2 text-left font-normal",
                          selected?.id === queue.id ? "hover:bg-secondary" : "hover:bg-transparent",
                        )}
                      >
                        <CalendarClock className="size-4 shrink-0 text-ink-3" />
                        <span className="min-w-0 space-y-0.5">
                          <span className="block truncate text-(length:--font-size-control) font-medium">
                            {queue.name}
                          </span>
                          <span className="block truncate text-(length:--font-size-micro) text-ink-3">
                            {queue.timezone}
                          </span>
                        </span>
                      </Button>
                      {canManageConfiguration && (
                        <QueueActions queue={queue} onEdit={editQueue} onDelete={deleteQueue} />
                      )}
                    </div>
                  ))}
                </div>
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
