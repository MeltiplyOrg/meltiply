// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as authClientModule from "@/lib/auth-client";
import type * as envModule from "@/lib/env";

import { SignInForm } from "./sign-in-form";

// The form reads `isDevMode()` before prefill; tests flip the seam rather than
// relying on whatever mode Vitest itself runs under.
const devMode = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof envModule>();
  return { ...actual, isDevMode: () => devMode.enabled };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SignInForm development prefill", () => {
  it("prefills the seeded owner credentials on the local sign-in form", async () => {
    devMode.enabled = true;
    vi.spyOn(authClientModule.authClient, "setupStatus").mockResolvedValue({ initialized: true });

    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <SignInForm />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Email address")).toHaveValue("alpha@meltiply.local");
    });
    expect(screen.getByLabelText("Password")).toHaveValue("MeltiplyLocal1!");
  });

  it("leaves the credentials empty outside development mode", async () => {
    devMode.enabled = false;
    vi.spyOn(authClientModule.authClient, "setupStatus").mockResolvedValue({ initialized: true });

    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <SignInForm />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("keeps first-run setup credentials empty", async () => {
    devMode.enabled = true;
    vi.spyOn(authClientModule.authClient, "setupStatus").mockResolvedValue({ initialized: false });

    render(
      <MemoryRouter initialEntries={["/sign-in"]}>
        <SignInForm />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
});
