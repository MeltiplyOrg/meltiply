// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useWorkspaceNavigate } from "./navigation";

afterEach(cleanup);

const router = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

describe("useWorkspaceNavigate", () => {
  it.each([
    ["no search", undefined, "/queues"],
    ["a search that starts with ?", { search: "?post=1" }, "/queues?post=1"],
    ["a search without ?", { search: "post=1" }, "/queues?post=1"],
  ])("%s", (_example, options, href) => {
    const { result } = renderHook(
      () => ({ navigate: useWorkspaceNavigate(), location: useLocation() }),
      { wrapper: router },
    );

    act(() => result.current.navigate("queues", options));

    expect(`${result.current.location.pathname}${result.current.location.search}`).toEqual(href);
  });
});
