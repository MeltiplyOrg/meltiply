import type { Post } from "@meltiply/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { setupServer } from "msw/node";
import { createPreviewHandlers } from "./handlers";

const origin = "http://localhost:3000";
vi.stubGlobal("location", new URL(origin));
const server = setupServer(...createPreviewHandlers());
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers(...createPreviewHandlers()));
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});
const postPath = `${origin}/api/v1/posts/00000000-0000-4000-8000-000000000701`;
const profileId = "00000000-0000-4000-8000-000000000111";

/** Exercises browser-preview behavior through HTTP, including scenario scope, read-after-edit/reset, authentication, and fail-closed misses. */
describe("contract-driven UI preview HTTP boundary", () => {
  it("returns empty collections without removing the authenticated workspace shell", async () => {
    server.resetHandlers(...createPreviewHandlers({ scenario: "empty" }));
    const session = await fetch(`${origin}/api/auth/get-session`).then((response) =>
      response.json(),
    );
    const posts = await fetch(`${origin}/api/v1/posts`).then((response) => response.json());
    expect(posts.posts).toEqual([]);
    const profile = await fetch(`${origin}/api/v1/users/me`).then((response) => response.json());
    expect(profile.active_organization.role).toBe("admin");
    expect(session.user.email).toBe(profile.email);
  });

  it("keeps draft edits local and resets them with a fresh preview", async () => {
    const original = await fetch(postPath).then((response) => response.json());
    const changed = await fetch(postPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_profile_id: profileId, default_text: "A preview-only edit" }),
    });
    expect(changed.ok).toBe(true);
    expect((await fetch(postPath).then((response) => response.json())).default_text).toBe(
      "A preview-only edit",
    );
    server.resetHandlers(...createPreviewHandlers());
    expect((await fetch(postPath).then((response) => response.json())).default_text).toBe(
      original.default_text,
    );
  });

  it("rejects requests outside the contract rather than contacting an upstream", async () => {
    const response = await fetch(`${origin}/api/v1/unhandled`, { method: "POST" });
    expect(response.status).toBe(501);
    expect((await response.json()).error.code).toBe("preview_unhandled");
  });

  it("removes a deleted sample without losing separately created or unrelated Posts", async () => {
    const before = await fetch(`${origin}/api/v1/posts?limit=100`).then((response) =>
      response.json(),
    );
    const created = await fetch(`${origin}/api/v1/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_profile_id: profileId, default_text: "Keep this sample" }),
    }).then((response) => response.json());
    expect((await fetch(postPath, { method: "DELETE" })).ok).toBe(true);
    expect((await fetch(postPath)).status).toBe(404);
    const list = await fetch(`${origin}/api/v1/posts?limit=100`).then((response) =>
      response.json(),
    );
    expect(list.posts.some((post: { id: string }) => post.id === postPath.split("/").at(-1))).toBe(
      false,
    );
    expect(list.posts.find((post: { id: string }) => post.id === created.id)?.default_text).toBe(
      "Keep this sample",
    );
    expect(list.posts.map((post: { id: string }) => post.id).sort()).toEqual(
      [
        ...before.posts
          .filter((post: { id: string }) => post.id !== postPath.split("/").at(-1))
          .map((post: { id: string }) => post.id),
        created.id,
      ].sort(),
    );
  });

  it("scopes exact error responses to one operation without mutating successful data", async () => {
    server.resetHandlers(
      ...createPreviewHandlers({ operationId: "updatePost", responseStatus: 422 }),
    );
    const original = await fetch(postPath).then((response) => response.json());
    const response = await fetch(postPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_profile_id: profileId, default_text: "Must not be saved" }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_error");
    expect((await fetch(postPath).then((response) => response.json())).default_text).toBe(
      original.default_text,
    );
    expect((await fetch(`${origin}/api/v1/users/me`)).status).toBe(200);
  });

  it("allows signed-out and second-factor journeys without real authentication", async () => {
    server.resetHandlers(...createPreviewHandlers({ scenario: "two-factor" }));
    expect(
      await fetch(`${origin}/api/auth/get-session`).then((response) => response.json()),
    ).toBeNull();
    const challenge = await fetch(`${origin}/api/auth/sign-in/email`, { method: "POST" }).then(
      (response) => response.json(),
    );
    expect(challenge.twoFactorRedirect).toBe(true);
    await fetch(`${origin}/api/auth/two-factor/verify-totp`, { method: "POST" });
    const profile = await fetch(`${origin}/api/v1/users/me`).then((response) => response.json());
    expect(
      (await fetch(`${origin}/api/auth/get-session`).then((response) => response.json())).user
        .email,
    ).toBe(profile.email);
  });

  it("exposes failed publication and expired Channel recovery states from the shared examples", async () => {
    server.resetHandlers(...createPreviewHandlers({ scenario: "publication-failed" }));
    const post = await fetch(`${origin}/api/v1/posts`)
      .then((response) => response.json())
      .then((body: { posts: Post[] }) => body.posts.find((post) => post.distributions.length > 0));
    expect(post?.status).toBe("active");
    expect(post?.distributions[0]?.status).toBe("failed");
    expect(post?.distributions[0]?.failure?.retryable).toBe(true);
    server.resetHandlers(...createPreviewHandlers({ scenario: "channel-expired" }));
    const channels = await fetch(`${origin}/api/v1/platforms`).then((response) => response.json());
    expect(channels.accounts[0].connection_status).toBe("reconnect_required");
  });

  it("keeps generated workspace identities coherent across pagination, Channels, Queues, and calendar events", async () => {
    const first = await fetch(`${origin}/api/v1/posts?limit=60`).then((response) =>
      response.json(),
    );
    const second = await fetch(`${origin}/api/v1/posts?limit=60&offset=60`).then((response) =>
      response.json(),
    );
    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(false);
    const posts: Post[] = [...first.posts, ...second.posts];
    const ids = posts.map((post: { id: string }) => post.id);
    expect(new Set(ids).size).toBe(ids.length);
    const profiles = await fetch(`${origin}/api/v1/brand-profiles`).then((response) =>
      response.json(),
    );
    const accounts = await fetch(`${origin}/api/v1/platforms`).then((response) => response.json());
    const queues = await fetch(`${origin}/api/v1/queues`).then((response) => response.json());
    const profileIds = new Set<string>(
      profiles.profiles.map((profile: { id: string }) => profile.id),
    );
    const accountIds = new Set<string>(
      accounts.accounts.map((account: { id: string }) => account.id),
    );
    for (const post of posts) {
      expect(profileIds.has(post.brand_profile_id)).toBe(true);
      for (const distribution of post.distributions) {
        expect(distribution.post_id).toBe(post.id);
        expect(distribution.brand_profile_id).toBe(post.brand_profile_id);
        expect(
          typeof distribution.platform_account_id === "string" &&
            accountIds.has(distribution.platform_account_id),
        ).toBe(true);
      }
    }
    expect(posts.some((post) => post.status === "draft")).toBe(true);
    for (const status of ["scheduled", "published", "failed"])
      expect(
        posts.some((post) =>
          post.distributions.some(
            (distribution: { status: string }) => distribution.status === status,
          ),
        ),
      ).toBe(true);
    expect(
      queues.items.map((queue: { brand_profile_id: string }) => queue.brand_profile_id).sort(),
    ).toEqual([...profileIds].sort());
    const calendar = await fetch(`${origin}/api/v1/calendar`).then((response) => response.json());
    for (const event of calendar.events) {
      const post = posts.find((post) => post.id === event.post_id);
      expect(post).toBeDefined();
      expect(
        post?.distributions.find((distribution) => distribution.id === event.id)?.scheduled_at,
      ).toBe(event.scheduled_at);
    }
  });
});
