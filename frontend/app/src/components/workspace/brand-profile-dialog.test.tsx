// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type * as I18nModule from "@/lib/i18n";
import type { BrandProfile } from "@/types";

const workspace = vi.hoisted(() => ({
  selectedBrandProfileId: null as string | null,
  setSelectedBrandProfileId: vi.fn(),
}));

const mutations = vi.hoisted(() => ({
  create: { error: null as Error | null, isPending: false, mutate: vi.fn() },
  delete: { error: null as Error | null, isPending: false, mutate: vi.fn() },
  update: { error: null as Error | null, isPending: false, mutate: vi.fn() },
}));

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => workspace,
}));
vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: true, workspaceId: "workspace-1" }),
}));
/** Uses the real English translator so pending and alert copy match the shipped catalog. */
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return {
    ...actual,
    useI18n: () => ({
      t: (value: string) => actual.translate("en", value),
    }),
  };
});
vi.mock("@/lib/queries", () => ({
  useCreateBrandProfile: () => mutations.create,
  useDeleteBrandProfile: () => mutations.delete,
  useUpdateBrandProfile: () => mutations.update,
}));

import { BrandProfileDialog } from "./brand-profile-dialog";

const profile: BrandProfile = {
  color: "#b91c1c",
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  description: "Editorial tools for independent publishers.",
  id: "00000000-0000-4000-8000-000000000001",
  name: "Alpha Brand",
  org_id: "00000000-0000-4000-8000-000000000010",
  purge_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  workspace.selectedBrandProfileId = profile.id;
  workspace.setSelectedBrandProfileId.mockReset();
  for (const mutation of Object.values(mutations)) {
    mutation.error = null;
    mutation.isPending = false;
    mutation.mutate.mockReset();
  }
});

afterEach(cleanup);

/**
 * Renders the editor for the supplied mode.
 *
 * `rerender` re-reads the mock mutation objects, which stand in for TanStack's
 * reactive mutation state after a rejected request.
 */
function renderEditor({ editing, onClose = vi.fn() }: { editing: boolean; onClose?: () => void }) {
  const view = render(
    <BrandProfileDialog open onOpenChange={onClose} profile={editing ? profile : null} />,
  );
  const title = editing ? "Update Brand Profile" : "Create Brand Profile";
  return {
    dialog: screen.getByRole("dialog", { name: title }),
    onClose,
    rerender: () =>
      view.rerender(
        <BrandProfileDialog open onOpenChange={onClose} profile={editing ? profile : null} />,
      ),
  };
}

/** Returns the pinned action region that owns the failure alert and footer buttons. */
function actionRegion(dialog: HTMLElement): HTMLElement {
  const region = dialog.querySelector<HTMLElement>("[data-brand-profile-dialog-actions]");
  if (!region) throw new Error("the dialog has no pinned action region");
  return region;
}

describe("Brand Profile dialog pending states", () => {
  it("labels a pending create truthfully and disables every action", () => {
    mutations.create.isPending = true;
    const { dialog } = renderEditor({ editing: false });

    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Create profile" })).toBeNull();
  });

  it("labels a pending update truthfully and disables the whole action group", () => {
    mutations.update.isPending = true;
    const { dialog } = renderEditor({ editing: true });

    expect(within(dialog).getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Update profile" })).toBeNull();
  });

  it("disables the editor's delete trigger while a deletion is pending", () => {
    mutations.delete.isPending = true;
    const { dialog } = renderEditor({ editing: true });

    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("Brand Profile dialog failure surface", () => {
  it("pins the mutation alert and footer in one region after the palette", () => {
    mutations.update.error = new Error("A required dependency is temporarily unavailable.");
    const { dialog } = renderEditor({ editing: true });

    const region = actionRegion(dialog);
    expect(within(region).getByRole("alert")).toHaveTextContent(
      "A required dependency is temporarily unavailable.",
    );
    expect(within(region).getByRole("button", { name: "Update profile" })).toBeVisible();
    expect(within(region).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(region).getByRole("button", { name: "Delete profile" })).toBeVisible();

    const palette = dialog.querySelector("[data-brand-color-palette]");
    expect(palette).not.toBeNull();
    // The pinned region follows the palette so native scrolling can expose every swatch.
    expect(
      palette!.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reserves the pinned region's height as dialog scroll padding", () => {
    const { dialog } = renderEditor({ editing: false });
    const region = actionRegion(dialog);

    expect(dialog.style.scrollPaddingBottom).toBe(`${region.offsetHeight}px`);
  });

  it("keeps a failed create open with its draft intact and the alert visible", () => {
    const { dialog, onClose, rerender } = renderEditor({ editing: false });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Draft brand" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));

    expect(mutations.create.mutate).toHaveBeenCalledTimes(1);
    const [, options] = mutations.create.mutate.mock.calls[0]!;
    expect(options.onSuccess).toEqual(expect.any(Function));

    mutations.create.error = new Error("Create failed");
    rerender();

    const openDialog = screen.getByRole("dialog", { name: "Create Brand Profile" });
    expect(within(openDialog).getByLabelText("Profile name")).toHaveValue("Draft brand");
    expect(within(actionRegion(openDialog)).getByRole("alert")).toHaveTextContent("Create failed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a failed update open with its dirty draft intact", () => {
    const { dialog, onClose, rerender } = renderEditor({ editing: true });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Renamed brand" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update profile" }));

    expect(mutations.update.mutate).toHaveBeenCalledTimes(1);
    const [, options] = mutations.update.mutate.mock.calls[0]!;
    expect(options.onSuccess).toEqual(expect.any(Function));

    mutations.update.error = new Error("Update failed");
    rerender();

    const openDialog = screen.getByRole("dialog", { name: "Update Brand Profile" });
    expect(within(openDialog).getByLabelText("Profile name")).toHaveValue("Renamed brand");
    expect(within(actionRegion(openDialog)).getByRole("alert")).toHaveTextContent("Update failed");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Brand Profile dialog deletion selection", () => {
  /** Opens the destructive confirmation from the editor and confirms it. */
  function confirmDelete(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete Brand Profile" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
    return mutations.delete.mutate.mock.calls.at(-1)!;
  }

  it("clears the workspace selection when the deleted profile is selected", () => {
    const onDeleteSuccess = vi.fn();
    const onClose = vi.fn();
    render(
      <BrandProfileDialog
        open
        onOpenChange={onClose}
        profile={profile}
        onDeleteSuccess={onDeleteSuccess}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Update Brand Profile" });

    const [profileId, options] = confirmDelete(dialog);
    expect(profileId).toBe(profile.id);
    options.onSuccess();

    expect(workspace.setSelectedBrandProfileId).toHaveBeenCalledWith(null);
    expect(onDeleteSuccess).toHaveBeenCalledWith(profile.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves the selection untouched when a different profile is deleted", () => {
    workspace.selectedBrandProfileId = "00000000-0000-4000-8000-000000000099";
    render(<BrandProfileDialog open onOpenChange={vi.fn()} profile={profile} />);
    const dialog = screen.getByRole("dialog", { name: "Update Brand Profile" });

    const [, options] = confirmDelete(dialog);
    options.onSuccess();

    expect(workspace.setSelectedBrandProfileId).not.toHaveBeenCalled();
  });

  it("shows a delete failure in the pinned region after the confirmation closes", () => {
    const { dialog, rerender } = renderEditor({ editing: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete Brand Profile" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete profile" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    mutations.delete.error = new Error("Delete failed");
    rerender();

    const openDialog = screen.getByRole("dialog", { name: "Update Brand Profile" });
    expect(within(actionRegion(openDialog)).getByRole("alert")).toHaveTextContent("Delete failed");
    expect(within(openDialog).getByLabelText("Profile name")).toHaveValue(profile.name);
  });
});
