import { Schema } from "effect";
import { http, HttpResponse } from "msw";
import { BRAND_PROFILE_COLORS, type Post, type PublishingQueue } from "@/types";
import {
  accounts,
  analytics,
  capabilities,
  createPosts,
  profileId,
  profiles,
  timestamp,
  user,
  userId,
} from "./data";
import { createPreviewUploads } from "./uploads";

const targetSchema = Schema.Struct({
  platform_account_id: Schema.String,
  title_override: Schema.optional(Schema.NullOr(Schema.String)),
  description_override: Schema.optional(Schema.NullOr(Schema.String)),
  hashtags: Schema.optional(Schema.Array(Schema.String)),
  attachment_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const postSchema = Schema.Struct({
  brand_profile_id: Schema.String,
  title: Schema.optional(Schema.String),
  default_text: Schema.optional(Schema.String),
  attachment_ids: Schema.optional(Schema.Array(Schema.String)),
  targets: Schema.optional(Schema.Array(targetSchema)),
});
const queueSchema = Schema.Struct({
  brand_profile_id: Schema.String,
  name: Schema.String,
  timezone: Schema.String,
  slots: Schema.Array(Schema.Struct({ weekday: Schema.Number, time: Schema.String })),
});

/** Returns an explicit preview-only error; unsupported operations never fall through to a real service. */
function blocked(message = "This operation is unavailable in the synthetic UI preview.") {
  return HttpResponse.json(
    {
      error: {
        code: "preview_unavailable",
        message,
        request_id: "ui-preview",
        retryable: false,
        details: [],
      },
    },
    { status: 422 },
  );
}

/** Creates handlers with browser-tab-local state. Recreating them (on reload) restores all sample data. Unknown requests fail closed. */
export function createPreviewHandlers() {
  let posts = createPosts();
  const uploads = createPreviewUploads();
  const brandProfiles = structuredClone(profiles);
  let channels = structuredClone(accounts);
  const queues: PublishingQueue[] = [
    {
      id: "00000000-0000-4000-8000-000000000801",
      brand_profile_id: profileId,
      name: "Weekly updates",
      timezone: "UTC",
      slots: [
        { weekday: 1, time: "09:30" },
        { weekday: 4, time: "14:00" },
      ],
      created_at: timestamp,
      updated_at: timestamp,
    },
  ];
  let signedIn = true;
  return [
    ...uploads.handlers,
    http.get("/api/auth/get-session", () =>
      HttpResponse.json(
        signedIn
          ? {
              user: { id: userId, email: user.email, name: user.display_name, emailVerified: true },
              session: {
                id: "preview-session",
                userId,
                expiresAt: new Date(Date.now() + 86400000).toISOString(),
              },
            }
          : null,
      ),
    ),
    http.get("/api/auth/setup-status", () => HttpResponse.json({ initialized: true })),
    http.post("/api/auth/sign-out", () => {
      signedIn = false;
      return HttpResponse.json({ success: true });
    }),
    http.post("/api/auth/sign-in/email", () => {
      signedIn = true;
      return HttpResponse.json({
        user: { id: userId, email: user.email, name: user.display_name },
        token: "synthetic-preview-not-a-credential",
      });
    }),
    http.get("/api/v1/users/me", () => HttpResponse.json(user)),
    http.get("/api/v1/brand-profiles", () =>
      HttpResponse.json({ profiles: brandProfiles.filter((profile) => !profile.deleted_at) }),
    ),
    http.post("/api/v1/brand-profiles", async ({ request }) => {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          color: Schema.Literals(BRAND_PROFILE_COLORS),
          description: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )(await request.json());
      const profile = {
        ...profiles[0]!,
        ...input,
        id: crypto.randomUUID(),
        description: input.description ?? null,
      };
      brandProfiles.push(profile);
      return HttpResponse.json(profile, { status: 201 });
    }),
    http.patch("/api/v1/brand-profiles/:id", async ({ params, request }) => {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          color: Schema.optional(Schema.Literals(BRAND_PROFILE_COLORS)),
          description: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      )(await request.json());
      const profile = brandProfiles.find((profile) => profile.id === params.id);
      if (!profile) return blocked("Sample Brand Profile not found.");
      Object.assign(profile, input);
      return HttpResponse.json(profile);
    }),
    http.delete("/api/v1/brand-profiles/:id", ({ params }) => {
      const profile = brandProfiles.find((profile) => profile.id === params.id);
      if (!profile) return blocked("Sample Brand Profile not found.");
      profile.deleted_at = new Date().toISOString();
      profile.purge_at = new Date(Date.now() + 604800000).toISOString();
      channels = channels.filter((channel) => channel.brand_profile_id !== profile.id);
      return HttpResponse.json(profile);
    }),
    http.get("/api/v1/platforms", ({ request }) => {
      const id = new URL(request.url).searchParams.get("brand_profile_id");
      return HttpResponse.json({
        accounts: channels.filter((channel) => !id || channel.brand_profile_id === id),
      });
    }),
    http.get("/api/v1/platforms/capabilities", () => HttpResponse.json({ capabilities })),
    http.delete("/api/v1/platforms/:id", ({ params }) => {
      channels = channels.filter((channel) => channel.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/v1/posts", ({ request }) => {
      const query = new URL(request.url).searchParams;
      const filtered = posts.filter(
        (post) =>
          (!query.get("brand_profile_id") ||
            post.brand_profile_id === query.get("brand_profile_id")) &&
          (!query.get("status") || post.status === query.get("status")),
      );
      const offset = Math.max(0, Number(query.get("offset")) || 0);
      const limit = Math.min(60, Math.max(1, Number(query.get("limit")) || 60));
      return HttpResponse.json({
        posts: filtered.slice(offset, offset + limit),
        has_more: offset + limit < filtered.length,
        limit,
        offset,
      });
    }),
    http.get("/api/v1/posts/:id", ({ params }) => {
      const post = posts.find((post) => post.id === params.id);
      return post ? HttpResponse.json(post) : blocked("Sample Post not found.");
    }),
    http.post("/api/v1/posts", async ({ request }) => {
      const input = Schema.decodeUnknownSync(postSchema)(await request.json());
      const post: Post = {
        ...createPosts()[0]!,
        id: crypto.randomUUID(),
        brand_profile_id: input.brand_profile_id,
        title: input.title ?? "",
        default_text: input.default_text ?? "",
        attachments: (input.attachment_ids ?? []).flatMap((id, position) => {
          const item = uploads.assets.get(id);
          return item ? [{ asset_id: id, position, asset: item }] : [];
        }),
        targets: (input.targets ?? []).map((target) => ({
          platform_account_id: target.platform_account_id,
          title_override: target.title_override ?? null,
          description_override: target.description_override ?? null,
          hashtags: [...(target.hashtags ?? [])],
          provider_options: null,
          attachment_ids: target.attachment_ids ? [...target.attachment_ids] : null,
        })),
      };
      posts.unshift(post);
      return HttpResponse.json(post, { status: 201 });
    }),
    http.patch("/api/v1/posts/:id", async ({ params, request }) => {
      const input = Schema.decodeUnknownSync(postSchema)(await request.json());
      const post = posts.find(
        (post) => post.id === params.id && post.brand_profile_id === input.brand_profile_id,
      );
      if (!post) return blocked("Sample Post not found in this Brand Profile.");
      if (input.title !== undefined) post.title = input.title;
      if (input.default_text !== undefined) post.default_text = input.default_text;
      if (input.attachment_ids)
        post.attachments = input.attachment_ids.flatMap((id, position) => {
          const item = uploads.assets.get(id);
          return item ? [{ asset_id: id, position, asset: item }] : [];
        });
      if (input.targets)
        post.targets = input.targets.map((target) => ({
          platform_account_id: target.platform_account_id,
          title_override: target.title_override ?? null,
          description_override: target.description_override ?? null,
          hashtags: [...(target.hashtags ?? [])],
          provider_options: null,
          attachment_ids: target.attachment_ids ? [...target.attachment_ids] : null,
        }));
      post.revision++;
      post.updated_at = new Date().toISOString();
      return HttpResponse.json(post);
    }),
    http.delete("/api/v1/posts/:id", ({ params }) => {
      posts = posts.filter((post) => post.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/v1/platforms/:id/publishing-requirements", () =>
      HttpResponse.json({
        platform: "tiktok",
        creator: { display_name: "Preview Creator", username: "preview.studio", avatar_url: null },
        privacy_levels: ["SELF_ONLY"],
        comment_allowed: true,
        duet_allowed: false,
        stitch_allowed: false,
        max_video_duration_sec: 600,
      }),
    ),
    http.get("/api/v1/calendar", ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json({
        events: posts
          .filter(
            (post) =>
              !query.get("brand_profile_id") ||
              post.brand_profile_id === query.get("brand_profile_id"),
          )
          .flatMap((post) =>
            post.distributions.map((distribution) => ({
              id: distribution.id,
              brand_profile_id: post.brand_profile_id,
              post_id: post.id,
              post_title: post.title,
              platform: distribution.platform,
              platform_account_id: distribution.platform_account_id,
              status: distribution.status,
              scheduled_at: distribution.scheduled_at,
              published_at: distribution.published_at,
              updated_at: distribution.updated_at,
            })),
          ),
      });
    }),
    http.get("/api/v1/distributions", () =>
      HttpResponse.json({
        distributions: posts.flatMap((post) => post.distributions),
        has_more: false,
        limit: 60,
        offset: 0,
      }),
    ),
    http.get("/api/v1/queues", ({ request }) => {
      const id = new URL(request.url).searchParams.get("brand_profile_id");
      return HttpResponse.json({
        items: queues.filter((queue) => !id || queue.brand_profile_id === id),
        next_cursor: null,
      });
    }),
    http.post("/api/v1/queues", async ({ request }) => {
      const input = Schema.decodeUnknownSync(queueSchema)(await request.json());
      const queue = {
        ...input,
        slots: [...input.slots],
        id: crypto.randomUUID(),
        created_at: timestamp,
        updated_at: timestamp,
      };
      queues.push(queue);
      return HttpResponse.json(queue, { status: 201 });
    }),
    http.patch("/api/v1/queues/:id", async ({ params, request }) => {
      const input = Schema.decodeUnknownSync(queueSchema)(await request.json());
      const queue = queues.find((queue) => queue.id === params.id);
      if (!queue) return blocked();
      Object.assign(queue, input);
      return HttpResponse.json(queue);
    }),
    http.delete("/api/v1/queues/:id", ({ params }) => {
      const index = queues.findIndex((queue) => queue.id === params.id);
      if (index >= 0) queues.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/v1/analytics/dashboard", ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json(
        analytics(query.get("start") ?? timestamp, query.get("end") ?? timestamp),
      );
    }),
    http.get("/api/v1/analytics/posts", () =>
      HttpResponse.json({ posts: [], has_more: false, limit: 10, offset: 0 }),
    ),
    http.get("/api/v1/installation", () =>
      HttpResponse.json({
        installation_owner_user_id: userId,
        seat_limit: 10,
        seats_used: 1,
        members_active: 1,
        invitations_pending: 0,
        workspace: { ...user.active_organization, created_at: timestamp, updated_at: timestamp },
      }),
    ),
    http.get("/api/v1/workspaces/:id/members", () =>
      HttpResponse.json({
        members: [
          {
            user_id: userId,
            email: user.email,
            display_name: user.display_name,
            avatar_url: null,
            role: "admin",
            status: "active",
            suspended_at: null,
            is_installation_owner: true,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      }),
    ),
    http.get("/api/v1/workspaces/:id/invitations", () => HttpResponse.json({ invitations: [] })),
    http.get("/api/v1/workspaces/:id/audit", () =>
      HttpResponse.json({ entries: [], has_more: false, limit: 100, offset: 0 }),
    ),
    http.post("/__frontend-telemetry", () => new HttpResponse(null, { status: 204 })),
    http.all(/\/api(?:\/|$)/, () => blocked()),
  ];
}
