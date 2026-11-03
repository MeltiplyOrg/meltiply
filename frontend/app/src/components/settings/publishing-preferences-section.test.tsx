// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PublishingPreferencesSection } from "./publishing-preferences-section";

const state = vi.hoisted(() => ({
  preferences: null as unknown,
  toast: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: true, workspaceId: "workspace-1" }),
}));

vi.mock("@/lib/queries", () => ({
  usePublishingPreferences: () => ({
    data: state.preferences,
    error: null,
    isPending: false,
  }),
  useUpdatePublishingPreferences: () => ({ mutateAsync: state.update }),
}));

vi.mock("@meltiply/ui/toast", () => ({ toast: state.toast }));

vi.mock("@/components/posts/queue-timezone-picker", () => ({
  QueueTimezonePicker: () => <div>Timezone picker</div>,
}));

/** Builds one saved preference document with the email channel enabled. */
function preferences() {
  return {
    email_available: true,
    notifications: {
      channels: { email: { enabled: true, recipients: ["ops@meltiply.local"] } },
      events: { channel_disconnected: false, publication_failed: true },
    },
    signature_templates: [],
    timezone: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  state.preferences = preferences();
  state.toast.mockReset();
  state.update.mockReset().mockResolvedValue(preferences());
});

afterEach(cleanup);

describe("publishing preferences recipients", () => {
  it("adds and removes email recipients before saving the whole document", async () => {
    render(<PublishingPreferencesSection />);

    expect(screen.getByLabelText("Recipient 1")).toHaveValue("ops@meltiply.local");

    fireEvent.click(screen.getByRole("button", { name: "Add recipient" }));
    fireEvent.change(screen.getByLabelText("Recipient 2"), {
      target: { value: "alpha@meltiply.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove recipient 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]?.[0].notifications.channels.email).toEqual({
      enabled: true,
      recipients: ["alpha@meltiply.local"],
    });
  });

  it("refuses to save an enabled email channel without a recipient", async () => {
    state.preferences = {
      ...preferences(),
      notifications: {
        channels: { email: { enabled: true, recipients: [] } },
        events: { channel_disconnected: false, publication_failed: true },
      },
    };
    render(<PublishingPreferencesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

    expect(state.update).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      "Add at least one recipient before enabling email.",
      expect.objectContaining({ variant: "error" }),
    );
  });
});
