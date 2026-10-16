// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAuthProvider, useMeltiplyAuth } from "@/components/auth/auth-provider";
import { WorkspaceProvider } from "@/context/workspace.context";
import { createAssetUpload, type AssetUploadTask } from "@/lib/upload";
import type { Asset, Post } from "@/types";

import { Composer } from "./composer";
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
  const { setBrandProfileId } = useMeltiplyAuth();
  return (
    <>
      <button onClick={() => setBrandProfileId(profileId)}>switch-profile</button>
      <button onClick={() => setBrandProfileId(null)}>switch-all</button>
    </>
  );
}

/** The shared-content textarea every composer interaction in this suite types into. */
function composerTextarea() {
  return screen.getByPlaceholderText(/what do you want to publish/i);
}

/** Mounts the composer inside the real auth, workspace, i18n, and query providers. */
function renderComposer(options: { initialPostId?: string; post?: Post } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seeded data stays fresh so focused tests never hit the network for it.
  queryClient.setQueryDefaults(queryKeys.posts(), { staleTime: Infinity });
  queryClient.setQueryData(queryKeys.platforms(), []);
  if (options.post) queryClient.setQueryData(queryKeys.post(options.post.id), options.post);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppAuthProvider>
          <WorkspaceProvider>
            <Composer initialPostId={options.initialPostId} />
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
      "meltiply.composer.v1.personal::all::new",
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-01T12:00:00.000Z",
        sharedContent: "Recovered paragraph",
        scheduleDate: "",
        attachments: [],
        removedAssetIds: [],
        channelOverrides: {},
        attachmentOverrides: {},
      }),
    );
    act(() => {
      writeCookieConsent({ functional: true, analytics: false, marketing: false });
    });

    await waitFor(() => expect(textarea).toHaveValue("Recovered paragraph"));
    await waitFor(() => expect(textarea).toBeEnabled());
  });
});

describe("Composer identity switching", () => {
  /**
   * Regression: returning to the previous identity must run the same abandon
   * pass as leaving it — the second switch is only skipped when the ref that
   * tracks the last cancelled identity was never updated, which used to leave
   * Brand Profile B's draft visible under Brand Profile A.
   */
  it("clears composer state when switching profiles and back", async () => {
    renderComposer();
    const textarea = composerTextarea();
    await waitFor(() => expect(textarea).toBeEnabled());

    fireEvent.change(textarea, { target: { value: "aggregate draft" } });
    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(textarea).toBeEnabled());
    expect(textarea).toHaveValue("");

    fireEvent.change(textarea, { target: { value: "profile b draft" } });
    fireEvent.click(screen.getByRole("button", { name: "switch-all" }));
    await waitFor(() => expect(textarea).toBeEnabled());
    expect(textarea).not.toHaveValue("profile b draft");
  });

  /**
   * Regression: leaving an identity abandons its in-flight uploads too — the
   * transfer's cancel handle must be invoked and its row must not survive into
   * the identity the composer returns to.
   */
  it("cancels in-flight uploads when switching profiles and back", async () => {
    renderComposer();
    await waitFor(() => expect(composerTextarea()).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "switch-profile" }));
    await waitFor(() => expect(composerTextarea()).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Add Media"), {
      target: { files: [new File(["bytes"], "clip.mp4", { type: "video/mp4" })] },
    });
    expect(await screen.findByText(/clip\.mp4/)).toBeInTheDocument();
    const task = vi.mocked(createAssetUpload).mock.results[0].value as AssetUploadTask;

    fireEvent.click(screen.getByRole("button", { name: "switch-all" }));
    await waitFor(() => expect(task.cancel).toHaveBeenCalled());
    expect(screen.queryByText(/clip\.mp4/)).not.toBeInTheDocument();
  });
});
