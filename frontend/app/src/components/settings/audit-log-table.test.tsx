// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AUDIT_PAGE_SIZE,
  AuditLogTable,
  type AuditFilters,
} from "@/components/settings/audit-log-table";
import type { AuditEntry } from "@/types";

const EMPTY_FILTERS: AuditFilters = { action: "", q: "", targetType: "" };

const ENTRIES: AuditEntry[] = [
  {
    action: "member.role_changed",
    actor: { display_name: "Alpha Creator", email: "alpha@meltiply.local" },
    after: { role: "editor" },
    before: { role: "viewer" },
    created_at: "2026-01-01T00:05:00.000Z",
    id: "f0000000-0000-4000-8000-000000000013",
    request_id: "request-alpha",
    target_id: "10000000-0000-4000-8000-000000000003",
    target_type: "member",
  },
  {
    action: "invitation.created",
    actor: { display_name: null, email: "beta@meltiply.local" },
    after: null,
    before: null,
    created_at: "2026-01-01T00:04:00.000Z",
    id: "f0000000-0000-4000-8000-000000000014",
    request_id: "request-beta",
    target_id: "f0000000-0000-4000-8000-000000000001",
    target_type: "invitation",
  },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Renders the audit log with inert callbacks.
 *
 * @param overrides - Entry window, filter, and pagination overrides.
 * @returns Callback spies bound to the rendered table.
 */
function renderTable(overrides: Partial<React.ComponentProps<typeof AuditLogTable>> = {}) {
  const spies = {
    onActionChange: vi.fn(),
    onOffsetChange: vi.fn(),
    onRefresh: vi.fn(),
    onReset: vi.fn(),
    onSearchChange: vi.fn(),
    onTargetTypeChange: vi.fn(),
  };
  render(
    <AuditLogTable
      entries={ENTRIES}
      filters={EMPTY_FILTERS}
      hasMore={false}
      isPending={false}
      isRefreshing={false}
      offset={0}
      {...spies}
      {...overrides}
    />,
  );
  return spies;
}

describe("audit log table", () => {
  it("lists audit entries and expands their recorded state", () => {
    renderTable();

    expect(screen.getByRole("table", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByText("member.role_changed")).toBeInTheDocument();
    expect(screen.getByText("alpha@meltiply.local")).toBeInTheDocument();
    expect(screen.getByText("invitation.created")).toBeInTheDocument();
    expect(screen.queryByText("request-alpha")).toBeNull();

    const details = screen.getAllByRole("button", { name: "Show details" });
    fireEvent.click(details[0]!);

    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("request-alpha")).toBeInTheDocument();
    expect(screen.getByText(/"role": "viewer"/)).toBeInTheDocument();
    expect(screen.getByText(/"role": "editor"/)).toBeInTheDocument();
  });

  it("shows the empty result for a filtered page and clears filters", () => {
    const spies = renderTable({
      entries: [],
      filters: { action: "member.removed", q: "", targetType: "" },
    });

    expect(screen.getByText("No audit entries match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(spies.onReset).toHaveBeenCalledTimes(1);
  });

  it("debounces typed search before applying it", () => {
    vi.useFakeTimers();
    const spies = renderTable();

    fireEvent.change(screen.getByRole("textbox", { name: "Search audit log" }), {
      target: { value: "alpha" },
    });
    expect(spies.onSearchChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(spies.onSearchChange).toHaveBeenCalledWith("alpha");
  });

  it("pages backwards and forwards by the fixed page size", () => {
    const spies = renderTable({ hasMore: true, offset: AUDIT_PAGE_SIZE });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(spies.onOffsetChange).toHaveBeenCalledWith(AUDIT_PAGE_SIZE * 2);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(spies.onOffsetChange).toHaveBeenCalledWith(0);
  });

  it("refreshes the current page on demand", () => {
    const spies = renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(spies.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables refresh while the audit query is in flight", () => {
    renderTable({ isRefreshing: true });
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("disables paging at the first page and the end of the trail", () => {
    renderTable({ hasMore: false, offset: 0 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
});
