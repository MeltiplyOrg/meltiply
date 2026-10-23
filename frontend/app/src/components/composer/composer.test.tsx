// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAuthProvider, useMeltiplyAuth } from "@/components/auth/auth-provider";
import { WorkspaceProvider } from "@/context/workspace.context";
import { createAssetUpload, type AssetUploadTask } from "@/lib/upload";
import type { Asset, BrandProfile, PlatformAccount, Post } from "@/types";

import { Composer, type ComposerProps } from "./composer";
import { authClient } from "@/lib/auth-client";
import { I18nProvider } from "@/lib/i18n";
import { queryKeys } from "@/lib/queries";

vi.mock("@/lib/upload", async (importActual) => {
  const actual = await importActual<object>();
  return { ...actual, createAssetUpload: vi.fn() };
});

/**
 * Task whose transfer never settles on its own: the suite can only observe
 * abandonment through the composer's explicit cancel call.
 */
function neverSettlingUploadTask(): AssetUploadTask {
  const { promise } = Promise.withResolvers<Asset>();
  return {
    cancel: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    pause: vi.fn(),
    resume: vi.fn(),
    result: promise,
  };
}

/** Sidebar probe driving the same Brand Profile switch the workspace shell performs. */
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

/** The shared-content textarea every composer interaction in this suite types into. */
function composerTextarea() {
  return screen.getByPlaceholderText(/what do you want to publish/i);
}

/** Mounts the composer inside the real auth, workspace, i18n, and query providers. */
function renderComposer(
  options: {
    initialPostId?: string;
    post?: Post;
    /** Connected accounts the workspace sees; the composer selects eligible ones. */
    accounts?: PlatformAccount[];
    /** Published platform capabilities, keyed by platform like the API response. */
    capabilities?: ReturnType<typeof platformCapability>[];
    /** Ordered real profile records used to exercise default owner selection. */
    brandProfiles?: BrandProfile[];
    /** Composer-initiated workspace navigation, e.g. Manage Queues. */
    onNavigate?: ComposerProps["onNavigate"];
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seeded data stays fresh so focused tests never hit the network for it.
  queryClient.setQueryDefaults(queryKeys.posts(), { staleTime: Infinity });
  queryClient.setQueryDefaults(queryKeys.platforms(), { staleTime: Infinity });
  queryClient.setQueryDefaults(queryKeys.platformCapabilities(), { staleTime: Infinity });
  queryClient.setQueryData(queryKeys.platforms(), options.accounts ?? []);
  queryClient.setQueryData(queryKeys.platformCapabilities(), options.capabilities ?? []);
  if (options.brandProfiles) {
    queryClient.setQueryDefaults(queryKeys.brandProfiles(), { staleTime: Infinity });
    queryClient.setQueryData(queryKeys.brandProfiles(), options.brandProfiles);
  }
  if (options.post) queryClient.setQueryData(queryKeys.post(options.post.id), options.post);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppAuthProvider>
          <WorkspaceProvider>
            <Composer initialPostId={options.initialPostId} onNavigate={options.onNavigate} />
            <ProfileSwitchProbe profileId="profile-b" />
          </WorkspaceProvider>
        </AppAuthProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(authClient, "getSession").mockResolvedValue({
    session: { expiresAt: new Date(), id: "session-1", userId: "user-1" },
    user: { email: "user@example.com", id: "user-1" },
  });
  vi.mocked(createAssetUpload).mockReset().mockImplementation(neverSettlingUploadTask);
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

/**
 * One published capability record as the API sends it, with the caption bound
 * under test. Everything else is inert so a caption assertion reads one number.
 */
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

/** Connected Instagram account owned by the switched identity (`profile-b`). */
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

/** Two ordered owners make default selection distinguishable from saved ownership. */
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
    // The composer owns its destination picker: the Posts collection it was
    // opened over stays aggregate instead of re-filtering behind the drawer.
    expect(screen.getByLabelText("Collection profile")).toHaveTextContent("all");

    // A later collection switch must not replace the composition's own owner.
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
  /**
   * Regression: the recovery read is consent-gated, so without a functional
   * choice the read effect never marks the namespace read — initialization must
   * not keep the composer disabled waiting for a read that cannot run.
   */
  it("stays editable for a new composition when functional consent was never given", async () => {
    renderComposer();

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "draft without consent" } });
    expect(textarea).toHaveValue("draft without consent");
  });

  /**
   * Regression: an explicit functional rejection takes the same optional
   * storage path, so a deep-linked Post must still hydrate and become editable.
   */
  it("stays editable after hydrating a saved Post when functional consent is rejected", async () => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    renderComposer({ initialPostId: hydratedPost.id, post: hydratedPost });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toHaveValue("Hydrated server draft"));
    await waitFor(() => expect(textarea).toBeEnabled());
  });

  /**
   * Regression: consent accepted after mount must still perform the deferred
   * recovery read for the namespace that is current at that moment, restoring
   * the saved draft before persistence reopens for it.
   */
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
      writeCookieConsent({ functional: true, analytics: false, marketing: false });
    });

    await waitFor(() => expect(textarea).toHaveValue("Recovered paragraph"));
    await waitFor(() => expect(textarea).toBeEnabled());
  });
});

describe("Composer and collection scope", () => {
  /**
   * The composition belongs to the composer, not the Posts collection filter:
   * re-scoping the list behind an open drawer must neither discard the draft
   * nor rebuild the composer from the new collection profile.
   */
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

  /**
   * A collection switch is not a composition identity switch, so it must not
   * abandon the upload tasks the composer owns.
   */
  it("keeps an in-flight upload when the collection profile changes", async () => {
    renderComposer({ brandProfiles: composerProfiles });
    await waitFor(() => expect(composerTextarea()).toBeEnabled());
    // Wait for owner adoption: uploads need the composer's own Brand Profile.
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

/** Inline captions inherit live shared text until edited, including intentional blanks. */
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
  /**
   * The shared caption reaches every selected Channel, so the field locks at the
   * tightest selected platform's limit and states it beside the count instead of
   * letting the creator write text the API will reject per Channel.
   */
  it("locks the shared caption at the tightest selected platform limit", async () => {
    renderComposer({
      accounts: [instagramAccount],
      capabilities: [platformCapability("instagram", 12)],
    });
    const textarea = composerTextarea();
    // The probe switches the identity the composer composes under; wait for the
    // providers to settle first, or the switch is dropped while auth loads.
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(textarea).toBeEnabled());

    await screen.findByLabelText("Custom Text for Alpha Instagram");

    fireEvent.change(textarea, { target: { value: "x".repeat(20) } });
    expect(textarea).toHaveValue("x".repeat(12));
  });

  /**
   * Regression: the lock counts code points, exactly like the provider
   * validator, so a caption of emoji is not cut at half its real limit — and the
   * field reports one character per emoji rather than two.
   */
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

  /**
   * A platform that publishes no caption bound leaves the field unbounded: the
   * counter drops the limit and the caption keeps every character the creator
   * types.
   */
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

/**
 * Navigation out of the composer unmounts it. Without functional-storage
 * consent the recovery record is never written, so leaving from an in-composer
 * link must not silently discard the creator's composition.
 */
describe("Composer leave guard", () => {
  it("asks before leaving unsaved work that recovery cannot restore", async () => {
    const onNavigate = vi.fn();
    renderComposer({ onNavigate });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "Unsaved without functional storage" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save draft and continue" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Post must contain text content or at least one media item."),
    ).toBeInTheDocument();
  });

  it("leaves directly when functional recovery can restore the composition", async () => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
    const onNavigate = vi.fn();
    renderComposer({ onNavigate });

    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());
    fireEvent.change(textarea, { target: { value: "Recoverable draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Queues" }));

    expect(onNavigate).toHaveBeenCalledWith("queues", undefined);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
