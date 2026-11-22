// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider } from "@/lib/i18n";
import {
  PlatformSettings,
  providerDescriptorFor,
  settingsForAttachmentOrder,
  type PostTargetDraft,
} from "./platform-settings";
import { composeCaption } from "../../../../../packages/providers/src/validator";

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

it("keeps image alt text and tags with their Asset through reordering, replacement, and subset changes", () => {
  const original = settingsForAttachmentOrder(
    {
      media_options: [{ alt_text: "First image" }, { alt_text: "Second image" }],
    },
    ["first", "second"],
  );
  const reversed = settingsForAttachmentOrder(original, ["second", "first"]);
  expect(reversed.media_options).toEqual([
    { alt_text: "Second image" },
    { alt_text: "First image" },
  ]);
  const replaced = settingsForAttachmentOrder(reversed, ["new", "first"]);
  expect(replaced.media_options).toEqual([{}, { alt_text: "First image" }]);
  expect(settingsForAttachmentOrder(original, ["second"]).media_options).toEqual([
    { alt_text: "Second image" },
  ]);
  expect(original.media_options).toEqual([
    { alt_text: "First image" },
    { alt_text: "Second image" },
  ]);
  const single = settingsForAttachmentOrder(
    {
      content: { alt_text: "Only the original image", collaborators: ["creator"] },
    },
    ["original"],
  );
  const replacement = settingsForAttachmentOrder(single, ["replacement"]);
  expect(replacement.content).toEqual({ collaborators: ["creator"] });
  expect(replacement.media_options).toEqual([{}]);
});

it.each([
  { provider: "facebook", settings: { post_type: "story" } },
  { provider: "instagram", settings: { post_type: "story" } },
  { provider: "threads", settings: { post_type: "repost", repost_id: "12345678" } },
])(
  "does not leak a hidden Post title into captionless $provider content",
  ({ provider, settings }) => {
    const target: PostTargetDraft = { platform_account_id: "channel" };
    providerDescriptorFor(provider)!.applyTarget!(
      target,
      settings,
      provider === "threads" ? [] : ["image"],
      null,
      "publication",
    );
    expect(
      composeCaption({
        title: "Title from an earlier publishing method",
        titleOverride: target.title_override ?? null,
        defaultText: "",
        descriptionOverride: "",
        signature: null,
        hashtags: [],
      }),
    ).toBe("");
  },
);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

it("applies the Channel capability to inline validation", () => {
  render(
    <I18nProvider>
      <PlatformSettings
        provider="youtube"
        channelName="Main"
        channelId="channel"
        settings={{
          tags: ["a", "b", "c"].map((tag) => ({ value: tag, label: tag })),
        }}
        mediaKinds={["video"]}
        capability={{
          accepted_mime_types: [],
          analytics: false,
          asset_types: [],
          comments: false,
          connect_available: true,
          max_caption_length: null,
          max_file_size: null,
          max_hashtags: 2,
          max_media_count: null,
          max_video_duration_sec: null,
          min_media_count: 0,
          multi_asset_types: [],
          notes: [],
          platform: "youtube",
          publish: true,
          reply: false,
        }}
        onChange={() => {}}
      />
    </I18nProvider>,
  );
  expect(screen.getByText("Main: use no more than 2 tags.")).toBeInTheDocument();
});

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
