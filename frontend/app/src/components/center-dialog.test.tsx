// @vitest-environment jsdom
import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogTrigger,
} from "@meltiply/ui/center-dialog";
import {
  CenterAlertDialog,
  CenterAlertDialogAction,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogDescription,
  CenterAlertDialogFooter,
  CenterAlertDialogHeader,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";

/**
 * Ordinary centered dialog with a real trigger and a first form field, so the
 * tests observe the primitive's autofocus and opener-restoration behavior.
 */
function OrdinaryDialog({ closeLabel }: { closeLabel?: string }): React.ReactElement {
  return (
    <CenterDialog>
      <CenterDialogTrigger asChild>
        <button type="button">Open profile</button>
      </CenterDialogTrigger>
      <CenterDialogContent closeLabel={closeLabel} aria-describedby={undefined}>
        <CenterDialogHeader>
          <CenterDialogTitle>Edit profile</CenterDialogTitle>
        </CenterDialogHeader>
        <label>
          Profile name
          <input defaultValue="Original" />
        </label>
      </CenterDialogContent>
    </CenterDialog>
  );
}

/** Destructive confirmation that stays open until its owner answers. */
function DestructiveDialog(): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  return (
    <CenterAlertDialog open={open} onOpenChange={setOpen}>
      <CenterAlertDialogContent>
        <CenterAlertDialogHeader>
          <CenterAlertDialogTitle>Delete profile?</CenterAlertDialogTitle>
          <CenterAlertDialogDescription>This cannot be undone.</CenterAlertDialogDescription>
        </CenterAlertDialogHeader>
        <CenterAlertDialogFooter>
          <CenterAlertDialogCancel>Cancel</CenterAlertDialogCancel>
          <CenterAlertDialogAction>Delete profile</CenterAlertDialogAction>
        </CenterAlertDialogFooter>
      </CenterAlertDialogContent>
    </CenterAlertDialog>
  );
}

/**
 * Opens the ordinary fixture and waits for Radix's focus scope to settle on the
 * first field, which is also when the dismissable layer starts listening.
 */
async function openOrdinaryDialog(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Open profile" });
  await act(async () => {
    fireEvent.click(trigger);
  });
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Profile name" })).toHaveFocus();
  });
  return trigger;
}

/**
 * Presses the shared backdrop as a pointer would. Radix defers dismissal to the
 * click that follows pointer-down, so both events belong to one interaction.
 */
async function pointerSequenceOnBackdrop(): Promise<void> {
  const backdrop = document.querySelector("[data-dialog-backdrop]");
  if (!(backdrop instanceof HTMLElement)) throw new Error("dialog backdrop is missing");
  await act(async () => {
    fireEvent.pointerDown(backdrop, { button: 0 });
    fireEvent.click(backdrop);
  });
}

afterEach(async () => {
  await act(async () => cleanup());
});

describe("ordinary centered dialog dismissal", () => {
  it("dismisses on Escape and restores focus to the opener", async () => {
    render(<OrdinaryDialog />);
    const trigger = await openOrdinaryDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it("dismisses on an outside pointer sequence", async () => {
    render(<OrdinaryDialog />);
    await openOrdinaryDialog();

    await pointerSequenceOnBackdrop();

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("exposes the caller's localized close label", async () => {
    render(<OrdinaryDialog closeLabel="Dismiss editor" />);
    await openOrdinaryDialog();

    expect(screen.getByRole("button", { name: "Dismiss editor" })).toBeInTheDocument();
  });
});

describe("destructive centered dialog dismissal", () => {
  it("focuses Cancel and keeps the confirmation open on outside pointer interaction", async () => {
    render(<DestructiveDialog />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => {
      expect(cancel).toHaveFocus();
    });

    await pointerSequenceOnBackdrop();

    expect(screen.getByRole("alertdialog", { name: "Delete profile?" })).toBeInTheDocument();
    expect(cancel).toHaveFocus();
  });

  it("still cancels on Escape", async () => {
    render(<DestructiveDialog />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });
});
