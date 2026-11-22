// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { I18nProvider, useI18n } from "@/lib/i18n";
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

function InGerman({ children }: { children: React.ReactNode }) {
  const { language, setLanguage } = useI18n();
  useLayoutEffect(() => setLanguage("de"), [setLanguage]);
  return language === "de" ? children : null;
}

const dialog = (
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
);

function renderDialog() {
  return render(<I18nProvider>{dialog}</I18nProvider>);
}

describe("Calendar date detail localization", () => {
  it("titles the day in the active language", () => {
    render(
      <I18nProvider>
        <InGerman>{dialog}</InGerman>
      </I18nProvider>,
    );
    expect(screen.getByRole("heading", { name: /Oktober 2026/ })).toBeInTheDocument();
  });
});

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
