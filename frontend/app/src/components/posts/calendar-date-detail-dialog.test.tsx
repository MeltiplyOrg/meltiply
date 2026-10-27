// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { CalendarDateDetailDialog } from "./calendar-date-detail-dialog";
import type { PostRow } from "./types";

afterEach(cleanup);

const date = new Date(2026, 9, 23);

const post: PostRow = {
  id: "status-action-post",
  date: new Date(2026, 9, 23, 8).toISOString(),
  status: "scheduled",
  channels: [],
  brandProfileId: "profile",
};

/** Renders the real day dialog over one Post with every action enabled. */
function renderDialog() {
  return render(
    <I18nProvider>
      <CalendarDateDetailDialog
        selectedDate={date}
        posts={[post]}
        canMutate
        onClose={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onScheduleNew={() => {}}
        onViewDetails={() => {}}
        selectedIds={new Set()}
        onToggleSelection={() => {}}
        onSetSelection={() => {}}
      />
    </I18nProvider>,
  );
}

describe("Calendar date detail action semantics", () => {
  it("uses the primary treatment for creating and scheduling, and danger only for deletion", () => {
    renderDialog();

    const schedule = screen.getByRole("button", { name: "Schedule post for this date" });
    expect(schedule).toHaveClass("bg-primary");
    expect(schedule).not.toHaveClass("bg-destructive");

    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).not.toHaveClass("bg-destructive");

    const remove = screen.getByRole("button", { name: "Delete" });
    expect(remove).toHaveClass("text-destructive");
    expect(remove).not.toHaveClass("bg-primary");
  });
});
