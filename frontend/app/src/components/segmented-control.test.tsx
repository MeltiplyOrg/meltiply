// @vitest-environment jsdom
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";

beforeAll(() => {
  class ResizeObserverMock {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    addEventListener: () => {},
    addListener: () => {},
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
});

const GROUPINGS = ["day", "week", "month"] as const;
type Grouping = (typeof GROUPINGS)[number];

const GROUPING_LABELS: Record<Grouping, string> = {
  day: "Day",
  month: "Month",
  week: "Week",
};

/** Controlled consumer: proves selection travels and the tab stop follows it. */
function GroupingSelector({
  initial = "week",
  onSelect,
}: {
  initial?: Grouping;
  onSelect?: (value: Grouping, control: HTMLButtonElement) => void;
}) {
  const [value, setValue] = useState<Grouping>(initial);
  return (
    <SegmentedControl
      options={GROUPINGS}
      value={value}
      onChange={(next, control) => {
        onSelect?.(next, control);
        setValue(next);
      }}
      label="Group by"
      renderOption={(option) => <span>{GROUPING_LABELS[option]}</span>}
    />
  );
}

/** Account-menu theme preference shape: Radix menu radio items in a segment track. */
function ThemeMenu() {
  const [theme, setTheme] = useState("light");
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>Theme menu</DropdownMenuTrigger>
      <DropdownMenuContent highlight={false}>
        <DropdownMenuRadioGroup
          variant="segment"
          value={theme}
          onValueChange={setTheme}
          aria-label="Theme"
        >
          {["light", "dark", "system"].map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              variant="segment"
              onSelect={(event) => event.preventDefault()}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("SegmentedControl single-select semantics", () => {
  it("renders a named radiogroup with one checked radio and one tab stop", () => {
    render(<GroupingSelector />);

    const group = screen.getByRole("radiogroup", { name: "Group by" });
    expect(group).toHaveAttribute("aria-orientation", "horizontal");

    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Day", "Week", "Month"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("selects on click and moves the roving tab stop without extra focusing", () => {
    const onSelect = vi.fn();
    render(<GroupingSelector onSelect={onSelect} />);

    const group = screen.getByRole("radiogroup", { name: "Group by" });
    const day = within(group).getByRole("radio", { name: "Day" });
    fireEvent.click(day);

    expect(onSelect).toHaveBeenCalledWith("day", day);
    expect(day).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: "Week" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.tabIndex),
    ).toEqual([0, -1, -1]);
  });

  it("wraps arrow keys, selects with Home/End, and follows selection with focus", () => {
    render(<GroupingSelector />);
    const group = screen.getByRole("radiogroup", { name: "Group by" });
    const radio = (name: string) => within(group).getByRole("radio", { name });
    const press = (key: string) => {
      expect(fireEvent.keyDown(document.activeElement!, { key })).toBe(false);
    };
    const expectSelected = (name: string) => {
      expect(radio(name)).toHaveAttribute("aria-checked", "true");
      expect(radio(name)).toHaveFocus();
      expect(radio(name).tabIndex).toBe(0);
      expect(
        within(group)
          .getAllByRole("radio")
          .filter((item) => item.tabIndex === 0),
      ).toEqual([radio(name)]);
    };

    radio("Week").focus();
    press("ArrowRight");
    expectSelected("Month");
    press("ArrowRight");
    expectSelected("Day");
    press("ArrowLeft");
    expectSelected("Month");
    press("ArrowDown");
    expectSelected("Day");
    press("ArrowUp");
    expectSelected("Month");
    press("Home");
    expectSelected("Day");
    press("End");
    expectSelected("Month");
  });

  it("leaves modified arrow shortcuts to the browser and owner", () => {
    const onSelect = vi.fn();
    render(<GroupingSelector onSelect={onSelect} />);
    const group = screen.getByRole("radiogroup", { name: "Group by" });
    const week = within(group).getByRole("radio", { name: "Week" });
    week.focus();

    for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const) {
      expect(fireEvent.keyDown(week, { key: "ArrowRight", [modifier]: true })).toBe(true);
      expect(week).toHaveAttribute("aria-checked", "true");
      expect(week).toHaveFocus();
      expect(onSelect).not.toHaveBeenCalled();
    }

    // The unmodified key still selects, proving the guard is limited to shortcuts.
    expect(fireEvent.keyDown(week, { key: "ArrowRight" })).toBe(false);
    expect(within(group).getByRole("radio", { name: "Month" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(onSelect).toHaveBeenCalledWith(
      "month",
      within(group).getByRole("radio", { name: "Month" }),
    );
  });

  it("renders custom option content without changing selection", () => {
    render(
      <SegmentedControl
        options={["one", "two"] as const}
        value="one"
        onChange={() => {}}
        label="Custom labels"
        renderOption={(option) => <em data-testid={`option-${option}`}>{option.toUpperCase()}</em>}
      />,
    );

    expect(screen.getByTestId("option-one")).toHaveTextContent("ONE");
    expect(screen.getByRole("radio", { name: "ONE" })).toHaveAttribute("aria-checked", "true");
  });

  it("keeps selection working when the operating system requests reduced motion", () => {
    const media = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<GroupingSelector />);
      fireEvent.keyDown(screen.getByRole("radio", { name: "Week" }), { key: "ArrowRight" });
      expect(screen.getByRole("radio", { name: "Month" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Month" })).toHaveFocus();
    } finally {
      window.matchMedia = media;
    }
  });
});

describe("menu segment radio group", () => {
  it("keeps checked travel in the shared highlight instead of the item fill", () => {
    render(<ThemeMenu />);

    const group = screen.getByRole("group", { name: "Theme" });
    const items = within(group).getAllByRole("menuitemradio");
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    // The selection track owns one presentational highlight, and every segment
    // item is excluded from the menu's own hover pill selector so the two cannot
    // fight. Geometry itself is browser-only.
    expect(group.firstElementChild).toHaveAttribute("aria-hidden", "true");
    items.forEach((item) => {
      expect(item).toHaveAttribute("data-segment-item");
      expect(item).toHaveAttribute("data-dropdown-item");
      expect(item.matches("[data-dropdown-item]:not([data-segment-item])")).toBe(false);
    });

    fireEvent.click(items[1]!);
    expect(items[1]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveAttribute("aria-checked", "false");
    expect(group.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
