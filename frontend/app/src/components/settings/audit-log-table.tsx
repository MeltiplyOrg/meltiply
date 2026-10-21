import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { FilterSelect } from "@meltiply/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meltiply/ui/table";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { TopToolbarReset, TopToolbarSearch } from "@/components/layout/top-toolbar";
import { TopToolbarButton } from "@/components/primitives/top-toolbar-button";
import type { AuditEntry } from "@/types";

/** Audit page size; matches the contract's 100-entry ceiling for one request. */
export const AUDIT_PAGE_SIZE = 100;

/**
 * Action identifiers the Worker records. Kept as raw codes rather than prose so
 * the filter matches the stored value exactly; an unknown future action remains
 * visible in the log and reachable through search until this list is extended.
 */
const AUDIT_ACTIONS = [
  "account.deleted",
  "account.reactivated",
  "account.suspended",
  "brand_profile.created",
  "brand_profile.deleted",
  "brand_profile.restored",
  "brand_profile.updated",
  "channel.connected",
  "channel.disconnected",
  "installation.ownership_transferred",
  "invitation.accepted",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "member.removed",
  "member.role_changed",
  "workspace.renamed",
] as const;

/** Target kinds stored on an Audit entry. */
const AUDIT_TARGET_TYPES = [
  "brand_profile",
  "channel",
  "invitation",
  "member",
  "workspace",
] as const;

/** Applied server-side filters; an empty string means the filter is off. */
export interface AuditFilters {
  action: string;
  q: string;
  targetType: string;
}

export interface AuditLogTableProps {
  entries: readonly AuditEntry[];
  filters: AuditFilters;
  hasMore: boolean;
  isPending: boolean;
  isRefreshing: boolean;
  offset: number;
  onActionChange: (action: string) => void;
  onOffsetChange: (offset: number) => void;
  onRefresh: () => void;
  onReset: () => void;
  onSearchChange: (q: string) => void;
  onTargetTypeChange: (targetType: string) => void;
}

/** Delay before a typed search reaches the server; keeps page history readable. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Renders the Workspace Audit trail as a filtered, paginated log table.
 *
 * Filter state is applied server-side by the route so results stay complete
 * across pages; this component only reflects `entries`, `hasMore`, and `offset`.
 * The body scrolls independently so the page header, filters, and paging stay
 * reachable, and each entry expands to its before/after state and request id.
 *
 * @param props - Audit window, applied filters, and change callbacks.
 * @returns Audit log section with filters, scrollable table, and paging footer.
 */
export function AuditLogTable({
  entries,
  filters,
  hasMore,
  isPending,
  isRefreshing,
  offset,
  onActionChange,
  onOffsetChange,
  onRefresh,
  onReset,
  onSearchChange,
  onTargetTypeChange,
}: AuditLogTableProps): React.ReactElement {
  const { t, language } = useI18n();
  const [search, setSearch] = useState(filters.q);
  const searchTimer = useRef<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const hasActiveFilters = Boolean(filters.q || filters.action || filters.targetType);
  const page = Math.floor(offset / AUDIT_PAGE_SIZE) + 1;
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(language, { day: "numeric", month: "short", year: "numeric" }),
    [language],
  );
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    [language],
  );

  // The input keeps typed text until its debounce delivers it to the query key.
  // Every reset path lives in this component, so clearing `search` here is
  // enough to keep the visible field and the applied filter in step.
  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  const changeSearch = (value: string) => {
    setSearch(value);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      onSearchChange(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  const resetFilters = () => {
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    setSearch("");
    onReset();
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <TopToolbarSearch
          value={search}
          onChange={changeSearch}
          placeholder={t("Search audit log")}
          ariaLabel={t("Search audit log")}
          className="sm:w-64"
        />
        <div className="w-52 max-w-full">
          <FilterSelect
            value={filters.action || "all"}
            onValueChange={(value) => onActionChange(value === "all" ? "" : value)}
            aggregateOption={{ value: "all", label: t("All actions") }}
            options={AUDIT_ACTIONS.map((action) => ({ value: action, label: action }))}
            trigger={
              <TopToolbarButton label={filters.action || t("All actions")} className="w-full" />
            }
            ariaLabel={t("Action")}
            contentClassName="w-72"
          />
        </div>
        <div className="w-44 max-w-full">
          <FilterSelect
            value={filters.targetType || "all"}
            onValueChange={(value) => onTargetTypeChange(value === "all" ? "" : value)}
            aggregateOption={{ value: "all", label: t("All targets") }}
            options={AUDIT_TARGET_TYPES.map((targetType) => ({
              value: targetType,
              label: targetType,
            }))}
            trigger={
              <TopToolbarButton label={filters.targetType || t("All targets")} className="w-full" />
            }
            ariaLabel={t("Target")}
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isRefreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />
            {t("Refresh")}
          </Button>
          <TopToolbarReset hasActiveFilters={hasActiveFilters} onReset={resetFilters} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-card border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto">
          <Table variant="spreadsheet" className="min-w-220" aria-label={t("Audit log")}>
            <colgroup>
              <col className="w-44" />
              <col className="w-68" />
              <col className="w-64" />
              <col />
              <col className="w-10" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Time")}</TableHead>
                <TableHead>{t("Action")}</TableHead>
                <TableHead>{t("Actor")}</TableHead>
                <TableHead>{t("Target")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("Details")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-sm text-ink-2">
                    <span role="status">{t("Loading audit entries…")}</span>
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-sm text-ink-2">
                    <span className="flex flex-wrap items-center gap-2">
                      {hasActiveFilters
                        ? t("No audit entries match these filters.")
                        : t("No audit entries yet.")}
                      {hasActiveFilters && (
                        <Button variant="link" size="sm" onClick={resetFilters}>
                          {t("Clear filters")}
                        </Button>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => {
                  const expanded = expandedIds.has(entry.id);
                  const actorName = entry.actor.display_name?.trim() || entry.actor.email;
                  const hasState = entry.before !== null || entry.after !== null;
                  const createdAt = new Date(entry.created_at);
                  return [
                    <TableRow key={entry.id} data-testid={`audit-entry-${entry.id}`}>
                      <TableCell className="align-top">
                        <time dateTime={entry.created_at} className="block text-xs">
                          <span className="block whitespace-nowrap tabular-nums text-ink-2">
                            {dateFormat.format(createdAt)}
                          </span>
                          <span className="block whitespace-nowrap tabular-nums text-ink-3">
                            {timeFormat.format(createdAt)}
                          </span>
                        </time>
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="break-all font-mono text-xs text-ink" title={entry.action}>
                          {entry.action}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-ink">{actorName}</p>
                          <p className="truncate text-xs text-ink-3">{entry.actor.email}</p>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="min-w-0">
                          <p className="text-xs text-ink-2">{entry.target_type}</p>
                          <p
                            className="truncate font-mono text-xs text-ink-3"
                            title={entry.target_id}
                          >
                            {entry.target_id}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-expanded={expanded}
                          aria-controls={`audit-details-${entry.id}`}
                          aria-label={expanded ? t("Hide details") : t("Show details")}
                          onClick={() => toggleExpanded(entry.id)}
                        >
                          <ChevronDown
                            className={cn(
                              "size-3.5 transition-transform duration-150",
                              expanded && "rotate-180",
                            )}
                          />
                        </Button>
                      </TableCell>
                    </TableRow>,
                    ...(expanded
                      ? [
                          <TableRow key={`${entry.id}-details`}>
                            <TableCell
                              id={`audit-details-${entry.id}`}
                              colSpan={5}
                              className="h-auto bg-hover-2/50 py-3"
                            >
                              {hasState ? (
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div>
                                    <p className="mb-1 text-xs font-medium text-ink-2">
                                      {t("Before")}
                                    </p>
                                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control border border-line bg-surface p-2 font-mono text-(length:--font-size-micro) leading-relaxed text-ink-2">
                                      {JSON.stringify(entry.before, null, 2)}
                                    </pre>
                                  </div>
                                  <div>
                                    <p className="mb-1 text-xs font-medium text-ink-2">
                                      {t("After")}
                                    </p>
                                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control border border-line bg-surface p-2 font-mono text-(length:--font-size-micro) leading-relaxed text-ink-2">
                                      {JSON.stringify(entry.after, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-xs text-ink-2">
                                  {t("No state changes recorded.")}
                                </p>
                              )}
                              <p className="mt-2 text-xs text-ink-3">
                                <span className="font-medium">{t("Request ID")}: </span>
                                <span className="break-all font-mono">{entry.request_id}</span>
                              </p>
                            </TableCell>
                          </TableRow>,
                        ]
                      : []),
                  ];
                })
              )}
            </TableBody>
          </Table>
        </div>
        {!isPending && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-ink-3">
            <span className="tabular-nums">
              {entries.length > 0
                ? `${offset + 1}–${offset + entries.length}`
                : t("No entries on this page")}
            </span>
            <div className="flex items-center gap-2">
              <span className="tabular-nums">{t("Page {page}", { page })}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => onOffsetChange(Math.max(0, offset - AUDIT_PAGE_SIZE))}
              >
                {t("Previous page")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasMore}
                onClick={() => onOffsetChange(offset + AUDIT_PAGE_SIZE)}
              >
                {t("Next page")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
