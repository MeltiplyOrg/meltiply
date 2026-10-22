// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";

afterEach(cleanup);

beforeAll(() => {
  // jsdom does not implement scrollIntoView; Radix Select calls it when its
  // popover content mounts and focuses the selected item.
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * Verifies the shared width contract consumed by `motion.css`: every list
 * surface opts into its trigger's measured width, so a wide field or toolbar
 * control never opens a narrower menu.
 */
it("marks a dropdown surface as trigger-width anchored", async () => {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>One</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );

  fireEvent.pointerDown(screen.getByRole("button", { name: "Open menu" }));
  expect(await screen.findByRole("menu")).toHaveAttribute("data-menu-fit-trigger", "dropdown");
});

it("marks a select surface as trigger-width anchored", async () => {
  render(
    <Select defaultValue="one">
      <SelectTrigger aria-label="Pick one">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">One</SelectItem>
      </SelectContent>
    </Select>,
  );

  fireEvent.click(screen.getByRole("combobox", { name: "Pick one" }));
  expect(await screen.findByRole("listbox")).toHaveAttribute("data-menu-fit-trigger", "select");
});
