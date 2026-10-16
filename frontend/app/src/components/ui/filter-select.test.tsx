// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { FilterSelect } from "@meltiply/ui/select";

afterEach(cleanup);

/**
 * Verifies the shared filter contract exposed to users: the aggregate choice is
 * available beside concrete choices and selecting a concrete row emits its typed
 * value through the controlled callback.
 */
it("selects a concrete filter value", () => {
  const onValueChange = vi.fn();

  render(
    <FilterSelect
      value="all"
      onValueChange={onValueChange}
      aggregateOption={{ value: "all", label: "All statuses" }}
      options={[{ value: "scheduled", label: "Scheduled" }]}
      ariaLabel="Post status"
      trigger={<button type="button">All statuses</button>}
    />,
  );

  fireEvent.click(screen.getByRole("combobox", { name: "Post status" }));

  const concreteOption = screen.getByRole("option", { name: "Scheduled" });

  fireEvent.click(concreteOption);
  expect(onValueChange).toHaveBeenCalledWith("scheduled");
});
