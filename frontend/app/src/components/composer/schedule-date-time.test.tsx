// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SideDialog } from "@meltiply/ui/side-dialog";
import { I18nProvider } from "@/lib/i18n";
import { ScheduleDateTime } from "./schedule-date-time";

afterEach(cleanup);

/** Mounts the real picker with the same localization owner used by the composer. */
function picker(value: string, onChange: (value: string) => void) {
  return (
    <I18nProvider>
      <ScheduleDateTime value={value} onChange={onChange} />
    </I18nProvider>
  );
}

/** These labels are local calendar dates, never UTC-derived ISO dates. */
function dateName(year: number, month: number, day: number): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(
    new Date(year, month, day, 12),
  );
}

describe("ScheduleDateTime", () => {
  it("browses into leap February without committing and preserves time when a day is chosen", () => {
    const onChange = vi.fn();
    render(picker("2028-01-31T23:47", onChange));
    const trigger = screen.getByRole("button", { name: /^Date / });
    fireEvent.click(trigger);
    const january31 = screen.getByRole("button", { name: dateName(2028, 0, 31) });
    expect(january31).toHaveFocus();

    fireEvent.keyDown(january31, { key: "PageDown" });
    const february29 = screen.getByRole("button", { name: dateName(2028, 1, 29) });
    expect(february29).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(february29);

    expect(onChange).toHaveBeenCalledWith("2028-02-29T23:47");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("changes hour and exact minute independently without changing the local date", () => {
    const onChange = vi.fn();
    const view = render(picker("2028-03-12T02:17", onChange));
    fireEvent.click(screen.getByRole("combobox", { name: "Hour" }));
    fireEvent.click(screen.getByRole("option", { name: "07" }));
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T07:17");

    view.rerender(picker("2028-03-12T07:17", onChange));
    fireEvent.click(screen.getByRole("combobox", { name: "Minute" }));
    fireEvent.click(screen.getByRole("option", { name: "43" }));
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T07:43");
  });

  it("moves keyboard focus across the year boundary and cancels without changing the schedule", () => {
    const onChange = vi.fn();
    const onDrawerChange = vi.fn();
    render(
      <I18nProvider>
        <SideDialog open onOpenChange={onDrawerChange} title="Schedule post">
          <ScheduleDateTime value="2028-12-31T09:26" onChange={onChange} />
        </SideDialog>
      </I18nProvider>,
    );
    const trigger = screen.getByRole("button", { name: /^Date / });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: dateName(2028, 11, 31) }), {
      key: "ArrowRight",
    });
    const january1 = screen.getByRole("button", { name: dateName(2029, 0, 1) });
    expect(january1).toHaveFocus();
    fireEvent.keyDown(january1, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onDrawerChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const nextMonth = screen.getByRole("button", { name: "Next month" });
    nextMonth.focus();
    fireEvent.keyDown(nextMonth, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onDrawerChange).not.toHaveBeenCalled();
  });
});
