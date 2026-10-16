// @vitest-environment jsdom
import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CenterDialog, CenterDialogContent, CenterDialogTitle } from "@meltiply/ui/center-dialog";
import {
  CenterAlertDialog,
  CenterAlertDialogCancel,
  CenterAlertDialogContent,
  CenterAlertDialogTitle,
} from "@meltiply/ui/center-alert-dialog";

/** Keeps an editable form mounted behind its nested destructive confirmation. */
function ProfileFlow(): React.ReactElement {
  const [confirm, setConfirm] = React.useState(false);
  return (
    <CenterDialog open>
      <CenterDialogContent aria-describedby={undefined}>
        <CenterDialogTitle>Edit profile</CenterDialogTitle>
        <label>
          Profile name
          <input defaultValue="Original" />
        </label>
        <button type="button" onClick={() => setConfirm(true)}>
          Delete profile
        </button>
        <CenterAlertDialog open={confirm} onOpenChange={setConfirm}>
          <CenterAlertDialogContent aria-describedby={undefined}>
            <CenterAlertDialogTitle>Delete profile?</CenterAlertDialogTitle>
            <CenterAlertDialogCancel>Keep profile</CenterAlertDialogCancel>
          </CenterAlertDialogContent>
        </CenterAlertDialog>
      </CenterDialogContent>
    </CenterDialog>
  );
}

afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
});

describe("centered dialog handoff accessibility", () => {
  it("keeps the edited input alive and excludes outgoing copies from accessible content", async () => {
    // Supply layout only: jsdom cannot measure a centered surface. Browser smoke
    // coverage verifies interpolation; this regression covers live form identity
    // and accessible content while the inert outgoing copy is still mounted.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(200, 200, 400, 200),
    );
    render(<ProfileFlow />);
    const input = screen.getByRole("textbox", { name: "Profile name" });
    fireEvent.change(input, { target: { value: "Edited profile" } });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete profile" })));
    expect(screen.getByRole("alertdialog", { name: "Delete profile?" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Profile name" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Delete profile?" })).toHaveLength(1);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep profile" })));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Profile name" })).toBe(input);
    expect(input).toHaveValue("Edited profile");
    expect(screen.getAllByRole("heading", { name: "Edit profile" })).toHaveLength(1);
  });
});
