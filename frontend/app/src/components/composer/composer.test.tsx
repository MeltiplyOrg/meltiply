// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
import {
  ApiError,
  getPlatformPublishingRequirements,
  getPost,
  updatePost,
  schedulePost,
} from "@/lib/api";
import type * as ApiModule from "@/lib/api";

import { AppAuthProvider, useMeltiplyAuth } from "@/components/auth/auth-provider";
import { WorkspaceProvider } from "@/context/workspace.context";
import { createAssetUpload, type AssetUploadTask } from "@/lib/upload";
import type {
  Asset,
  BrandProfile,
  PlatformAccount,
  Post,
  PublishingPreferences,
  TikTokPublishingRequirements,
} from "@/types";

import { Composer, type ComposerProps } from "./composer";
import { authClient } from "@/lib/auth-client";
import { I18nProvider } from "@/lib/i18n";
import { queryKeys } from "@/lib/queries";

vi.mock("@/lib/upload", async (importActual) => {
  const actual = await importActual<object>();
  return { ...actual, createAssetUpload: vi.fn() };
});

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof ApiModule>()),
  getPlatformPublishingRequirements: vi.fn(),
  getPost: vi.fn(),
  getPublishingPreferences: vi.fn(),
  updatePost: vi.fn(),
  schedulePost: vi.fn(),
}));

function neverSettlingUploadTask(): AssetUploadTask {
  const { promise } = Promise.withResolvers<Asset>();
  return {
    cancel: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    pause: vi.fn(),
    resume: vi.fn(),
    result: promise,
  };
}

function ProfileSwitchProbe({ profileId }: { profileId: string }) {
  const { brandProfileId, setBrandProfileId } = useMeltiplyAuth();
  return (
    <>
      <button onClick={() => setBrandProfileId(profileId)}>switch-profile</button>
      <button onClick={() => setBrandProfileId(null)}>switch-all</button>
      <output aria-label="Collection profile">{brandProfileId ?? "all"}</output>
    </>
  );
}

function composerTextarea() {
  return screen.getByPlaceholderText(/what do you want to publish/i);
}

function renderComposer(
  options: {
    initialPostId?: string;
    initialDate?: ComposerProps["initialDate"];
    post?: Post;
    accounts?: PlatformAccount[];
    capabilities?: ReturnType<typeof platformCapability>[];
    brandProfiles?: BrandProfile[];
    onNavigate?: ComposerProps["onNavigate"];
    requirements?: TikTokPublishingRequirements | null;
    preferences?: PublishingPreferences;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryDefaults(queryKeys.posts(), { staleTime: Infinity });
  queryClient.setQueryDefaults(queryKeys.platforms(), { staleTime: Infinity });
  queryClient.setQueryDefaults(queryKeys.platformCapabilities(), { staleTime: Infinity });
  queryClient.setQueryData(queryKeys.platforms(), options.accounts ?? []);
  queryClient.setQueryData(queryKeys.platformCapabilities(), options.capabilities ?? []);
  queryClient.setQueryDefaults(queryKeys.publishingPreferences(), { staleTime: Infinity });
  queryClient.setQueryData(
    queryKeys.publishingPreferences(),
    options.preferences ?? {
      email_available: false,
      notifications: {
        channels: { email: { enabled: false, recipients: [] } },
        events: { channel_disconnected: false, publication_failed: false },
      },
      signature_templates: [],
      timezone: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  );
  vi.mocked(getPlatformPublishingRequirements).mockImplementation(() =>
    options.requirements
      ? Effect.succeed(options.requirements)
      : Effect.fail(
          new ApiError(new Response(null, { status: 503 }), {
            error: { code: "provider_unavailable", message: "Creator information unavailable" },
          }),
        ),
  );
  if (options.brandProfiles) {
    queryClient.setQueryDefaults(queryKeys.brandProfiles(), { staleTime: Infinity });
    queryClient.setQueryData(queryKeys.brandProfiles(), options.brandProfiles);
  }
  if (options.post) {
    queryClient.setQueryData(queryKeys.post(options.post.id), options.post);
    vi.mocked(getPost).mockReturnValue(Effect.succeed(options.post));
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppAuthProvider>
          <WorkspaceProvider>
            <Composer
              initialPostId={options.initialPostId}
              initialDate={options.initialDate}
              onNavigate={options.onNavigate}
            />
            <ProfileSwitchProbe profileId="profile-b" />
          </WorkspaceProvider>
        </AppAuthProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

const futureSessionExpiry = new Date("2099-07-18T16:00:00Z");

beforeEach(() => {
  vi.spyOn(authClient, "getSession").mockResolvedValue({
    session: { expiresAt: futureSessionExpiry, id: "session-1", userId: "user-1" },
    user: { email: "user@example.com", id: "user-1" },
  });
  vi.mocked(createAssetUpload).mockReset().mockImplementation(neverSettlingUploadTask);
  vi.mocked(getPost).mockReset();
  vi.mocked(updatePost).mockReset();
  vi.mocked(schedulePost).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
});

const hydratedPost: Post = {
  analytics: null,
  distribution_analytics: [],
  queue_membership: null,
  id: "post-hydrated",
  org_id: "org-1",
  brand_profile_id: "profile-a",
  title: "",
  default_text: "Hydrated server draft",
  status: "draft",
  revision: 1,
  attachments: [],
  targets: [],
  distributions: [],
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
};

function platformCapability(
  platform: PlatformAccount["platform"],
  maxCaptionLength: number | null,
) {
  return {
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    connect_available: true,
    max_caption_length: maxCaptionLength,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: 0,
    multi_asset_types: [],
    notes: [],
    platform,
    publish: true,
    reply: false,
  };
}

const instagramAccount: PlatformAccount = {
  avatar_url: null,
  username: null,
  brand_profile_id: "profile-b",
  capabilities: platformCapability("instagram", 12),
  connection_status: "connected",
  created_at: "2026-01-01T00:00:00.000Z",
  display_name: "Alpha Instagram",
  id: "00000000-0000-4000-8000-000000000021",
  last_synced_at: null,
  org_id: "org-1",
  platform: "instagram",
  platform_user_id: "alpha-instagram",
  rate_limit_budget: null,
  scopes: [],
  token_expires_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const composerProfiles: BrandProfile[] = ["profile-a", "profile-b"].map((id, index) => ({
  id,
  name: index === 0 ? "Alpha Brand" : "Beta Brand",
  org_id: "org-1",
  description: null,
  color: "#b91c1c",
  deleted_at: null,
  purge_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
}));

describe("Composer default ownership", () => {
  it("preselects the first profile for a new Post without changing the collection filter", async () => {
    renderComposer({ brandProfiles: composerProfiles });
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Alpha Brand" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Alpha Brand" })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByLabelText("Collection profile")).toHaveTextContent("all");

    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Collection profile")).toHaveTextContent("profile-b"),
    );
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Alpha Brand" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Alpha Brand" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "Beta Brand" })).not.toBeChecked();
  });

  it("uses a reopened Post's owner without changing the collection filter", async () => {
    renderComposer({
      brandProfiles: composerProfiles,
      initialPostId: hydratedPost.id,
      post: { ...hydratedPost, brand_profile_id: "profile-b" },
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(hydratedPost.default_text));
    expect(screen.getByLabelText("Collection profile")).toHaveTextContent("all");
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Beta Brand" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Beta Brand" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "Alpha Brand" })).not.toBeChecked();
  });
});

describe("Composer recovery consent", () => {
  it("stays editable for a new composition when functional consent was never given", async () => {
    renderComposer();

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "draft without consent" } });
    expect(textarea).toHaveValue("draft without consent");
  });

  it("stays editable after hydrating a saved Post when functional consent is rejected", async () => {
    writeCookieConsent({ functional: false });
    renderComposer({ initialPostId: hydratedPost.id, post: hydratedPost });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toHaveValue("Hydrated server draft"));
    await waitFor(() => expect(textarea).toBeEnabled());
  });

  it("restores the current namespace's recovery record when functional consent arrives later", async () => {
    renderComposer();
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());

    window.localStorage.setItem(
      "meltiply.composer.v2.personal::all::new",
      JSON.stringify({
        version: 2,
        updatedAt: "2026-10-01T12:00:00.000Z",
        sharedContent: "Recovered paragraph",
        scheduleDate: "",
        attachments: [],
        removedAssetIds: [],
        channelOverrides: {},
        attachmentOverrides: {},
        profileIds: [],
        selectedChannelIds: [],
        profileCopies: {},
      }),
    );
    act(() => {
      writeCookieConsent({ functional: true });
    });

    await waitFor(() => expect(textarea).toHaveValue("Recovered paragraph"));
    await waitFor(() => expect(textarea).toBeEnabled());
  });

  it.each(["Recovered footer", null])(
    "restores the saved signature snapshot %s instead of the current default",
    async (signature) => {
      const account = { ...instagramAccount, brand_profile_id: "profile-a" };
      window.localStorage.setItem(
        "meltiply.composer.v2.personal::profile-a::post-hydrated",
        JSON.stringify({
          version: 2,
          updatedAt: "2026-10-01T12:00:00.000Z",
          sharedContent: "Recovered composition",
          scheduleDate: "",
          attachments: [],
          removedAssetIds: [],
          channelOverrides: {
            [account.id]: { content: "", hasOverride: false, settings: {}, signature },
          },
          attachmentOverrides: {},
          profileIds: ["profile-a"],
          selectedChannelIds: [account.id],
          profileCopies: {},
        }),
      );
      writeCookieConsent({ functional: true });
      vi.mocked(updatePost).mockReturnValue(Effect.succeed(hydratedPost));
      renderComposer({
        initialPostId: hydratedPost.id,
        post: hydratedPost,
        brandProfiles: composerProfiles,
        accounts: [account],
        preferences: {
          timezone: null,
          signature_templates: [
            {
              id: "00000000-0000-4000-8000-000000000901",
              body: "New default footer",
              name: "Default",
              is_default: true,
              position: 0,
            },
          ],
          email_available: false,
          notifications: {
            channels: { email: { enabled: false, recipients: [] } },
            events: { channel_disconnected: false, publication_failed: false },
          },
          updated_at: "2026-10-01T10:00:00.000Z",
        },
      });

      await waitFor(() => expect(composerTextarea()).toHaveValue("Recovered composition"));
      expect(screen.queryByText("New default footer")).not.toBeInTheDocument();
      if (signature !== null) expect(screen.getByText(signature)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(updatePost).toHaveBeenCalled());
      expect(vi.mocked(updatePost).mock.lastCall?.[2].targets?.[0]?.signature).toBe(signature);
    },
  );
});

describe("Composer caption counter", () => {
  it("marks a Channel counter when its signature pushes the caption past the limit", async () => {
    const account = { ...instagramAccount, brand_profile_id: "profile-a" };
    window.localStorage.setItem(
      "meltiply.composer.v2.personal::profile-a::post-hydrated",
      JSON.stringify({
        version: 2,
        updatedAt: "2026-10-01T12:00:00.000Z",
        sharedContent: "Recovered composition",
        scheduleDate: "",
        attachments: [],
        removedAssetIds: [],
        channelOverrides: {
          [account.id]: {
            content: "short",
            hasOverride: true,
            settings: {},
            signature: "Long footer",
          },
        },
        attachmentOverrides: {},
        profileIds: ["profile-a"],
        selectedChannelIds: [account.id],
        profileCopies: {},
      }),
    );
    writeCookieConsent({ functional: true });
    renderComposer({
      initialPostId: hydratedPost.id,
      post: hydratedPost,
      brandProfiles: composerProfiles,
      accounts: [account],
      capabilities: [platformCapability("instagram", 12)],
    });

    await waitFor(() => expect(composerTextarea()).toHaveValue("Recovered composition"));
    expect(screen.getAllByText(/\/12 characters/).at(-1)).toHaveClass("text-red");
  });
});

describe("Composer and collection scope", () => {
  it("keeps the composition when the collection profile changes", async () => {
    renderComposer({ brandProfiles: composerProfiles });
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());

    fireEvent.change(textarea, { target: { value: "aggregate draft" } });
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Collection profile")).toHaveTextContent("profile-b"),
    );
    expect(textarea).toHaveValue("aggregate draft");

    fireEvent.change(textarea, { target: { value: "profile b draft" } });
    fireEvent.click(screen.getByRole("button", { name: "switch-all" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Collection profile")).toHaveTextContent("all"),
    );
    expect(textarea).toHaveValue("profile b draft");
  });

  it("gives same-millisecond file selections distinct attachment keys", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = renderComposer({ brandProfiles: composerProfiles });
    await waitFor(() => expect(composerTextarea()).toBeEnabled());
    await screen.findByRole("button", { name: "Alpha Brand" });

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["same"], "clip.mp4", { type: "video/mp4" }),
          new File(["same"], "clip.mp4", { type: "video/mp4" }),
        ],
      },
    });

    expect(await screen.findAllByText(/clip\.mp4/)).toHaveLength(2);
    const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes("same key"),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });

  it("keeps an in-flight upload when the collection profile changes", async () => {
    renderComposer({ brandProfiles: composerProfiles });
    await waitFor(() => expect(composerTextarea()).toBeEnabled());
    await screen.findByRole("button", { name: "Alpha Brand" });

    fireEvent.change(screen.getByLabelText("Add Media"), {
      target: { files: [new File(["bytes"], "clip.mp4", { type: "video/mp4" })] },
    });
    expect(await screen.findByText(/clip\.mp4/)).toBeInTheDocument();
    const task = vi.mocked(createAssetUpload).mock.results[0].value as AssetUploadTask;

    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Collection profile")).toHaveTextContent("profile-b"),
    );
    expect(task.cancel).not.toHaveBeenCalled();
    expect(screen.getByText(/clip\.mp4/)).toBeInTheDocument();
  });
});

describe("Composer attachment ownership", () => {
  it("shows a failed ownership write and saves the attachment on an explicit retry", async () => {
    vi.mocked(updatePost)
      .mockReturnValueOnce(
        Effect.fail(
          new ApiError(new Response(null, { status: 503 }), {
            error: { code: "dependency_unavailable", message: "database unavailable" },
          }),
        ),
      )
      .mockReturnValue(Effect.succeed(hydratedPost));
    renderComposer({
      brandProfiles: composerProfiles,
      initialPostId: hydratedPost.id,
      post: hydratedPost,
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(hydratedPost.default_text));
    fireEvent.change(screen.getByLabelText("Add Media"), {
      target: { files: [new File(["bytes"], "clip.mp4", { type: "video/mp4" })] },
    });
    const upload = vi.mocked(createAssetUpload).mock.calls[0]![0];
    await act(async () => {
      await upload.onSessionStart?.("ownership-asset");
    });

    expect(await screen.findByText("An error has occurred.")).toBeVisible();
    expect(updatePost).toHaveBeenCalledTimes(1);
    fireEvent.change(composerTextarea(), { target: { value: "Keep this attachment" } });
    expect(updatePost).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(updatePost).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updatePost).mock.lastCall?.[2]).toMatchObject({
      attachment_ids: ["ownership-asset"],
      default_text: "Keep this attachment",
    });
    await waitFor(() =>
      expect(screen.queryByText("An error has occurred.")).not.toBeInTheDocument(),
    );
  });
});

describe("Composer channel captions", () => {
  it("keeps blank channel edits independent and restores live inheritance on reset", async () => {
    renderComposer({
      brandProfiles: [composerProfiles[1]!],
      accounts: [instagramAccount],
      capabilities: [platformCapability("instagram", 12)],
    });
    const channelCaption = await screen.findByLabelText("Custom Text for Alpha Instagram");
    const sharedCaption = composerTextarea();
    await waitFor(() => expect(sharedCaption).toBeEnabled());

    fireEvent.change(sharedCaption, { target: { value: "Shared" } });
    expect(channelCaption).toHaveValue("Shared");
    fireEvent.change(channelCaption, { target: { value: "" } });
    fireEvent.change(sharedCaption, { target: { value: "Changed" } });
    expect(channelCaption).toHaveValue("");
    expect(sharedCaption).toHaveValue("Changed");

    fireEvent.click(screen.getByRole("button", { name: "Remove Custom Override" }));
    expect(channelCaption).toHaveValue("Changed");
    fireEvent.change(sharedCaption, { target: { value: "Next" } });
    expect(channelCaption).toHaveValue("Next");
  });
});

describe("Composer caption bound", () => {
  it("locks the shared caption at the tightest selected platform limit", async () => {
    renderComposer({
      accounts: [instagramAccount],
      capabilities: [platformCapability("instagram", 12)],
    });
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(textarea).toBeEnabled());

    await screen.findByLabelText("Custom Text for Alpha Instagram");

    fireEvent.change(textarea, { target: { value: "x".repeat(20) } });
    expect(textarea).toHaveValue("x".repeat(12));
  });

  it("counts an emoji as one character when locking the caption", async () => {
    renderComposer({
      accounts: [instagramAccount],
      capabilities: [platformCapability("instagram", 12)],
    });
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(textarea).toBeEnabled());
    await screen.findByLabelText("Custom Text for Alpha Instagram");

    fireEvent.change(textarea, { target: { value: "🎉".repeat(15) } });
    const value = (textarea as HTMLTextAreaElement).value;
    expect([...value]).toHaveLength(12);
    expect(value.length).toBe(24);
  });

  it("leaves the caption unbounded when the platform publishes no limit", async () => {
    renderComposer({
      accounts: [instagramAccount],
      capabilities: [platformCapability("instagram", null)],
    });
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(textarea).toBeEnabled());

    fireEvent.change(textarea, { target: { value: "x".repeat(20) } });
    expect(textarea).toHaveValue("x".repeat(20));
  });
});

describe("Composer leave guard", () => {
  it("asks before leaving unsaved work that recovery cannot restore", async () => {
    const onNavigate = vi.fn();
    renderComposer({ onNavigate });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "Unsaved without functional storage" } });
    fireEvent.click(screen.getByRole("radio", { name: "Queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Save this Post before leaving?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
    expect(onNavigate).toHaveBeenCalledWith("queues", undefined);
  });

  it("keeps the composer open when the draft cannot be saved", async () => {
    const onNavigate = vi.fn();
    renderComposer({ onNavigate });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "draft" } });
    fireEvent.change(textarea, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save draft and continue" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Post must contain text content or at least one media item."),
    ).toBeInTheDocument();
  });

  it("leaves directly when functional recovery can restore the composition", async () => {
    writeCookieConsent({ functional: true });
    const onNavigate = vi.fn();
    renderComposer({ onNavigate });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "Recoverable draft" } });
    fireEvent.click(screen.getByRole("radio", { name: "Queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));

    expect(onNavigate).toHaveBeenCalledWith("queues", undefined);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("Composer schedule restoration", () => {
  it("keeps an untouched scheduled instant when the publishing timezone changes", async () => {
    const { queryClient } = renderComposer({
      brandProfiles: composerProfiles,
      initialPostId: hydratedPost.id,
      preferences: {
        timezone: "UTC",
        signature_templates: [],
        email_available: false,
        notifications: {
          channels: { email: { enabled: false, recipients: [] } },
          events: { channel_disconnected: false, publication_failed: false },
        },
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      post: {
        ...hydratedPost,
        distributions: [
          {
            id: "midnight-distribution",
            brand_profile_id: hydratedPost.brand_profile_id,
            org_id: hydratedPost.org_id,
            post_id: hydratedPost.id,
            platform_account_id: null,
            platform: "threads",
            status: "scheduled",
            scheduled_at: "2028-02-29T00:00:00.000Z",
            published_at: null,
            platform_post_id: null,
            platform_url: null,
            publication: null,
            title_override: null,
            description_override: null,
            hashtags: [],
            attempt_count: 0,
            last_attempt_at: null,
            next_attempt_at: null,
            failure: null,
            created_at: hydratedPost.created_at,
            updated_at: hydratedPost.updated_at,
          },
        ],
      },
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(hydratedPost.default_text));
    expect(screen.getByRole("radio", { name: "Schedule" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: /hour/i })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("spinbutton", { name: /minute/i })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    for (const [timezone, hour] of [
      ["Asia/Tokyo", "9"],
      ["UTC", "0"],
    ] as const) {
      act(() => {
        queryClient.setQueryData<PublishingPreferences>(
          queryKeys.publishingPreferences(),
          (current) => current && { ...current, timezone },
        );
      });
      await waitFor(() =>
        expect(screen.getByRole("spinbutton", { name: /hour/i })).toHaveAttribute(
          "aria-valuenow",
          hour,
        ),
      );
    }
  });

  it("keeps the daytime suggestion for a new calendar-day composition", async () => {
    renderComposer({
      brandProfiles: composerProfiles,
      initialDate: new Date(2028, 1, 29, 0, 0),
    });
    await waitFor(() => expect(composerTextarea()).toBeEnabled());
    expect(screen.getByRole("radio", { name: "Schedule" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: /hour/i })).toHaveAttribute(
      "aria-valuenow",
      "10",
    );
    expect(screen.getByRole("spinbutton", { name: /minute/i })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });
});

describe("Composer provider publication choices", () => {
  it("keeps unanswered YouTube visibility out of saved drafts and blocks delivery", async () => {
    const account = { ...instagramAccount, platform: "youtube" as const };
    const post: Post = {
      ...hydratedPost,
      brand_profile_id: account.brand_profile_id,
      targets: [
        {
          platform_account_id: account.id,
          attachment_ids: null,
          title_override: "Audience answered, visibility unanswered",
          description_override: null,
          hashtags: [],
          provider_options: { youtube: { made_for_kids: false } },
          signature: null,
        },
      ],
    };
    vi.mocked(updatePost).mockReturnValue(Effect.succeed(post));
    renderComposer({
      accounts: [account],
      capabilities: [platformCapability("youtube", null)],
      brandProfiles: composerProfiles,
      initialPostId: post.id,
      post,
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(post.default_text));
    expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent(
      "Choose visibility",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    expect(vi.mocked(updatePost).mock.lastCall?.[2].targets?.[0]?.provider_options).toEqual({
      youtube: { made_for_kids: false },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Now" }));
    expect(screen.getByRole("button", { name: "Publish Now" })).toBeDisabled();
  });

  it("restores YouTube visibility and audience from the saved target", async () => {
    const account = {
      ...instagramAccount,
      platform: "youtube" as const,
      display_name: "Video destination",
    };
    renderComposer({
      accounts: [account],
      brandProfiles: composerProfiles,
      initialPostId: hydratedPost.id,
      post: {
        ...hydratedPost,
        brand_profile_id: account.brand_profile_id,
        targets: [
          {
            platform_account_id: account.id,
            attachment_ids: null,
            title_override: "A saved video",
            description_override: null,
            hashtags: [],
            provider_options: { youtube: { made_for_kids: true, privacy_status: "unlisted" } },
            signature: null,
          },
        ],
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent("Unlisted"),
    );
    expect(screen.getByRole("combobox", { name: "Made for kids" })).toHaveTextContent("Yes");
  });

  it("preserves a saved signature snapshot when the default template changes", async () => {
    const account = {
      ...instagramAccount,
      platform: "youtube" as const,
      display_name: "Video destination",
    };
    const savedPost: Post = {
      ...hydratedPost,
      brand_profile_id: account.brand_profile_id,
      targets: [
        {
          platform_account_id: account.id,
          attachment_ids: null,
          title_override: "A saved video",
          description_override: null,
          hashtags: [],
          provider_options: { youtube: { made_for_kids: false, privacy_status: "public" } },
          signature: "Saved footer",
        },
      ],
    };
    vi.mocked(updatePost).mockReturnValue(Effect.succeed(savedPost));
    renderComposer({
      accounts: [account],
      brandProfiles: composerProfiles,
      capabilities: [platformCapability("youtube", 5000)],
      initialPostId: savedPost.id,
      post: savedPost,
      preferences: {
        email_available: false,
        notifications: {
          channels: { email: { enabled: false, recipients: [] } },
          events: { channel_disconnected: false, publication_failed: false },
        },
        signature_templates: [
          {
            body: "New template footer",
            id: "00000000-0000-4000-8000-000000000901",
            is_default: true,
            name: "Current default",
            position: 0,
          },
        ],
        timezone: "America/New_York",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(savedPost.default_text));
    expect(screen.getByText("Saved footer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    expect(vi.mocked(updatePost).mock.lastCall?.[2].targets?.[0]?.signature).toBe("Saved footer");
  });

  it("keeps a saved signature snapshot when a caption override is edited", async () => {
    const account = {
      ...instagramAccount,
      platform: "youtube" as const,
      display_name: "Video destination",
    };
    const savedPost: Post = {
      ...hydratedPost,
      brand_profile_id: account.brand_profile_id,
      targets: [
        {
          platform_account_id: account.id,
          attachment_ids: null,
          title_override: "A saved video",
          description_override: null,
          hashtags: [],
          provider_options: { youtube: { made_for_kids: false, privacy_status: "public" } },
          signature: "Saved footer",
        },
      ],
    };
    vi.mocked(updatePost).mockReturnValue(Effect.succeed(savedPost));
    renderComposer({
      accounts: [account],
      brandProfiles: composerProfiles,
      capabilities: [platformCapability("youtube", 5000)],
      initialPostId: savedPost.id,
      post: savedPost,
      preferences: {
        email_available: false,
        notifications: {
          channels: { email: { enabled: false, recipients: [] } },
          events: { channel_disconnected: false, publication_failed: false },
        },
        signature_templates: [
          {
            body: "New template footer",
            id: "00000000-0000-4000-8000-000000000901",
            is_default: true,
            name: "Current default",
            position: 0,
          },
        ],
        timezone: "America/New_York",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(savedPost.default_text));
    const channelCaption = await screen.findByLabelText("Custom Text for Video destination");

    fireEvent.change(channelCaption, { target: { value: "Edited per-channel caption" } });
    expect(screen.getByText("Saved footer")).toBeVisible();
    expect(screen.queryByText("New template footer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    const target = vi.mocked(updatePost).mock.lastCall?.[2].targets?.[0];
    expect(target?.description_override).toBe("Edited per-channel caption");
    expect(target?.signature).toBe("Saved footer");
  });

  it("requires TikTok interaction opt-in instead of granting it implicitly", async () => {
    const account = {
      ...instagramAccount,
      platform: "tiktok" as const,
      brand_profile_id: "profile-a",
    };
    renderComposer({
      accounts: [account],
      brandProfiles: composerProfiles,
      requirements: {
        platform: "tiktok",
        creator: { display_name: "Creator", username: "creator", avatar_url: null },
        comment_allowed: true,
        duet_allowed: false,
        stitch_allowed: true,
        max_video_duration_sec: 60,
        privacy_levels: ["SELF_ONLY"],
      },
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Comments" })).not.toBeChecked());
    expect(screen.getByRole("switch", { name: "Duet" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Duet" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Stitch" })).not.toBeChecked();
  });

  it("does not offer invented TikTok privacy choices when creator information is unavailable", async () => {
    renderComposer({
      accounts: [{ ...instagramAccount, platform: "tiktok", brand_profile_id: "profile-a" }],
      brandProfiles: composerProfiles,
    });
    expect(await screen.findByRole("combobox", { name: "Privacy Level" })).toBeDisabled();
  });

  it("preserves restricted TikTok interactions in drafts but disables them for delivery", async () => {
    const account = { ...instagramAccount, platform: "tiktok" as const };
    const savedPost = { ...hydratedPost, brand_profile_id: account.brand_profile_id };
    vi.mocked(updatePost).mockReturnValue(Effect.succeed(savedPost));
    vi.mocked(schedulePost).mockReturnValue(Effect.succeed(savedPost));
    renderComposer({
      accounts: [account],
      brandProfiles: composerProfiles,
      initialPostId: hydratedPost.id,
      requirements: {
        platform: "tiktok",
        creator: { display_name: "Creator", username: "creator", avatar_url: null },
        comment_allowed: false,
        duet_allowed: false,
        stitch_allowed: false,
        max_video_duration_sec: 60,
        privacy_levels: ["SELF_ONLY"],
      },
      post: {
        ...hydratedPost,
        brand_profile_id: account.brand_profile_id,
        targets: [
          {
            platform_account_id: account.id,
            attachment_ids: null,
            title_override: null,
            description_override: null,
            hashtags: [],
            provider_options: {
              tiktok: {
                privacy_level: "SELF_ONLY",
                allow_comment: true,
                allow_duet: true,
                allow_stitch: true,
                brand_content: false,
                brand_organic: false,
                is_ai_generated: false,
                music_usage_confirmed: true,
              },
            },
            signature: null,
          },
        ],
      },
    });
    await waitFor(() => expect(composerTextarea()).toHaveValue(hydratedPost.default_text));
    for (const name of ["Comments", "Duet", "Stitch"]) {
      expect(screen.getByRole("switch", { name })).not.toBeChecked();
      expect(screen.getByRole("switch", { name })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    expect(
      vi.mocked(updatePost).mock.lastCall?.[2].targets?.[0]?.provider_options?.tiktok,
    ).toMatchObject({
      allow_comment: true,
      allow_duet: true,
      allow_stitch: true,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish Now" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Publish Now" }));
    await waitFor(() => expect(schedulePost).toHaveBeenCalled());
    expect(
      vi.mocked(schedulePost).mock.lastCall?.[2].targets?.[0]?.provider_options?.tiktok,
    ).toMatchObject({
      allow_comment: false,
      allow_duet: false,
      allow_stitch: false,
    });
  });
});
