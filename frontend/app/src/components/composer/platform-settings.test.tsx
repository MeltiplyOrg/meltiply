// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider } from "@/lib/i18n";
import { PlatformSettings } from "./platform-settings";

vi.mock("@/hooks/use-session-scope", () => ({
  useSessionScope: () => ({ isSignedIn: false, workspaceId: null }),
}));
vi.mock("@/lib/queries", () => ({
  usePlatformPublishingRequirements: () => ({
    isFetchedAfterMount: false,
    isError: false,
    isFetching: false,
    data: undefined,
    refetch: vi.fn(),
  }),
}));

beforeAll(() => {
  // Radix focuses the selected option with an API jsdom does not implement.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

/** Keeps the real settings editor controlled as it is in the composer. */
function InstagramSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({
    post_type: "reel",
    trial_reel: true,
    trial_graduation: "performance",
  });
  return (
    <I18nProvider>
      <PlatformSettings
        provider="instagram"
        channelName="Instagram destination"
        channelId="instagram-channel"
        settings={settings}
        mediaKinds={["video"]}
        onChange={setSettings}
      />
    </I18nProvider>
  );
}

describe("Instagram publication shape transitions", () => {
  it.each(["Feed", "Story"])("keeps %s selected while disabling Trial Reel", async (postType) => {
    render(<InstagramSettings />);
    expect(screen.getByRole("switch", { name: "Trial Reel" })).toBeChecked();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Post type" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: postType }));

    expect(screen.getByRole("combobox", { name: "Post type" })).toHaveTextContent(postType);
    expect(screen.queryByRole("switch", { name: "Trial Reel" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Post type" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /^Reel$/ }));
    expect(screen.getByRole("switch", { name: "Trial Reel" })).not.toBeChecked();
  });
});
