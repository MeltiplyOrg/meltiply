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

/** Exercises real request/response boundaries, including isolation, mutable sample data, and reset semantics. */
describe("synthetic UI preview HTTP boundary", () => {
  it("signs in without credentials and resets draft edits with a fresh preview", async () => {
    const session = await fetch(`${origin}/api/auth/get-session`).then((response) =>
      response.json(),
    );
    expect(session.user.email).toBe("preview@example.test");
    const id = "00000000-0000-4000-8000-000000000701";
    const path = `${origin}/api/v1/posts/${id}`;
    const changed = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand_profile_id: "00000000-0000-4000-8000-000000000111",
        default_text: "A preview-only edit",
      }),
    });
    expect(changed.status).toBe(200);
    expect((await fetch(path).then((response) => response.json())).default_text).toBe(
      "A preview-only edit",
    );
    server.resetHandlers(...createPreviewHandlers());
    expect((await fetch(path).then((response) => response.json())).default_text).toContain(
      "synthetic sample content",
    );
  });

  it("rejects unknown endpoints and publishing rather than contacting an upstream", async () => {
    for (const path of ["/api/v1/unhandled", "/api/v1/posts/example/schedule"]) {
      const response = await fetch(`${origin}${path}`, { method: "POST" });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("preview_unavailable");
    }
  });

  it("deleting a sample Post removes it from subsequent reads without affecting other Posts", async () => {
    const id = "00000000-0000-4000-8000-000000000701";
    expect((await fetch(`${origin}/api/v1/posts/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${origin}/api/v1/posts/${id}`)).status).toBe(422);
    const list = await fetch(`${origin}/api/v1/posts`).then((response) => response.json());
    expect(list.posts.map((post: { id: string }) => post.id)).toEqual([
      "00000000-0000-4000-8000-000000000702",
      "00000000-0000-4000-8000-000000000703",
      "00000000-0000-4000-8000-000000000704",
    ]);
  });
});
