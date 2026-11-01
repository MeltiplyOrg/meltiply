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

/** Keeps the real Facebook settings editor controlled, as the composer does. */
function FacebookSettings({ initial }: { initial: Record<string, unknown> }) {
  const [settings, setSettings] = useState<Record<string, unknown>>(initial);
  return (
    <I18nProvider>
      <PlatformSettings
        provider="facebook"
        channelName="Facebook destination"
        channelId="facebook-channel"
        settings={settings}
        mediaKinds={["video"]}
        onChange={setSettings}
      />
    </I18nProvider>
  );
}

describe("Facebook publication shape transitions", () => {
  it("offers only the families the attachment set can carry", async () => {
    render(<FacebookSettings initial={{}} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Post type" }), { key: "Enter" });
    // A single video can only become a Reel or a Story on Facebook.
    // Radix marks a disabled option with `aria-disabled`, not the native attribute.
    expect(await screen.findByRole("option", { name: "Post" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("option", { name: "Photo post" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // An enabled option simply omits the attribute.
    expect(screen.getByRole("option", { name: "Reel" })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(screen.getByRole("option", { name: "Story" }));

    expect(screen.getByRole("combobox", { name: "Post type" })).toHaveTextContent("Story");
    expect(screen.getByRole("switch", { name: "Made with AI" })).toBeInTheDocument();
  });

  it("keeps the AI disclosure off for a post and hides the link off a post family", async () => {
    render(<FacebookSettings initial={{ post_type: "reel", is_ai_generated: true }} />);
    expect(screen.getByRole("switch", { name: "Made with AI" })).toBeChecked();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Post type" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Reel" }));
    expect(screen.getByRole("switch", { name: "Made with AI" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Link")).not.toBeInTheDocument();
  });
});

/** Keeps the real Threads settings editor controlled, as the composer does. */
function ThreadsSettings({ mediaKinds }: { mediaKinds: ("image" | "video")[] }) {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  return (
    <I18nProvider>
      <PlatformSettings
        provider="threads"
        channelName="Threads destination"
        channelId="threads-channel"
        settings={settings}
        mediaKinds={mediaKinds}
        onChange={setSettings}
      />
    </I18nProvider>
  );
}

describe("Threads publication controls", () => {
  it("offers a link attachment only for a text-only post", () => {
    const { rerender } = render(<ThreadsSettings mediaKinds={[]} />);
    expect(screen.getByLabelText("Link attachment")).toBeInTheDocument();
    rerender(<ThreadsSettings mediaKinds={["image"]} />);
    // Threads documents link attachments for text posts only.
    expect(screen.queryByLabelText("Link attachment")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Topic tag")).toBeInTheDocument();
  });

  it("stores the chosen reply control and topic tag", () => {
    render(<ThreadsSettings mediaKinds={[]} />);
    fireEvent.change(screen.getByLabelText("Topic tag"), { target: { value: "launch" } });
    expect(screen.getByLabelText("Topic tag")).toHaveValue("launch");
    expect(screen.getByRole("combobox", { name: "Who can reply" })).toHaveTextContent("Everyone");
  });
});
