// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { SideDialog } from "@meltiply/ui/side-dialog";
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
  it("browses into leap February without committing and preserves time when a day is chosen", async () => {
    const onChange = vi.fn();
    render(picker("2028-01-31T23:47", onChange));
    const trigger = screen.getByRole("button", { name: /^Date / });
    fireEvent.click(trigger);
    const january31 = screen.getByRole("button", { name: dateName(2028, 0, 31) });
    january31.focus();

    fireEvent.keyDown(january31, { key: "PageDown" });
    const february29 = screen.getByRole("button", { name: dateName(2028, 1, 29) });
    expect(february29).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(february29);

    expect(onChange).toHaveBeenCalledWith("2028-02-29T23:47");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("edits hour and exact minute independently without moving the local date", () => {
    const onChange = vi.fn();
    const view = render(picker("2028-03-12T23:59", onChange));
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: /hour/i }), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T00:59");
    view.rerender(picker("2028-03-12T00:59", onChange));
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: /minute/i }), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T00:00");
  });

  it("starts editing hours when the time field background is clicked without changing the schedule", () => {
    const onChange = vi.fn();
    render(picker("2028-03-12T07:17", onChange));
    fireEvent.click(screen.getByRole("group", { name: "Time" }));
    expect(screen.getByRole("spinbutton", { name: /hour/i })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves across the year boundary without committing until a day is chosen", () => {
    const onChange = vi.fn();
    render(picker("2028-12-31T09:26", onChange));
    fireEvent.click(screen.getByRole("button", { name: /^Date / }));
    const december31 = screen.getByRole("button", { name: dateName(2028, 11, 31) });
    december31.focus();
    fireEvent.keyDown(december31, { key: "ArrowRight" });
    const january1 = screen.getByRole("button", { name: dateName(2029, 0, 1) });
    expect(january1).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(january1);
    expect(onChange).toHaveBeenCalledWith("2029-01-01T09:26");
  });

  it("shows a recovered date after browsing without changing or focusing it", () => {
    const onChange = vi.fn();
    const view = render(picker("2028-01-31T23:47", onChange));
    fireEvent.click(screen.getByRole("button", { name: /^Date / }));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(picker("2029-06-08T14:22", onChange));
    const recovered = screen.getByRole("button", { name: dateName(2029, 5, 8) });
    expect(recovered.closest("[aria-selected]")).toHaveAttribute("aria-selected", "true");
    expect(recovered).not.toHaveFocus();
    expect(screen.getByRole("spinbutton", { name: /hour/i })).toHaveAttribute(
      "aria-valuenow",
      "14",
    );
    expect(screen.getByRole("spinbutton", { name: /minute/i })).toHaveAttribute(
      "aria-valuenow",
      "22",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dismisses the calendar without closing the composer or committing a schedule", async () => {
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
      key: "Escape",
    });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onDrawerChange).not.toHaveBeenCalled();
  });

  it("chooses an exact time from the clock picker without moving the local date", async () => {
    const onChange = vi.fn();
    const view = render(picker("2028-03-12T07:17", onChange));
    const clock = screen.getByRole("button", { name: "Choose time" });
    fireEvent.click(clock);
    fireEvent.click(screen.getByRole("combobox", { name: "Hour" }));
    fireEvent.click(screen.getByRole("option", { name: "14" }));
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T14:17");
    view.rerender(picker("2028-03-12T14:17", onChange));
    fireEvent.click(screen.getByRole("combobox", { name: "Minute" }));
    fireEvent.click(screen.getByRole("option", { name: "43" }));
    expect(onChange).toHaveBeenLastCalledWith("2028-03-12T14:43");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(clock).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Choose time" })).not.toBeInTheDocument();
  });
});
