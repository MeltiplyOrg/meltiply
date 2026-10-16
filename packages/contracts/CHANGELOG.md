# Contract changelog

## Unreleased

- Add explicit OAuth account selection endpoints for multi-account providers:
  `GET /oauth-selections/{selection_id}` (`getOAuthSelection`),
  `POST /oauth-selections/{selection_id}/confirm` (`confirmOAuthSelection`),
  and `DELETE /oauth-selections/{selection_id}` (`cancelOAuthSelection`)
  with `OAuthSelection`, `OAuthSelectionAccount`, and `OAuthSelectionConfirmRequest`
  schemas. Requests are scoped by `X-Workspace-ID` and authorized via bearer tokens;
  mutations require `Idempotency-Key`. Document that `GET /platforms/{platform}/callback`
  may redirect (302) to the Page picker view before persistence.
- Add required nullable `username` property (max 255 chars) to `PlatformAccount` and
  `OAuthSelectionAccount` for truthful external provider handle representation.
- Establish Better Auth cookie session transport (`cookieAuth`, same-origin
  `better-auth.session_token`) and the browser auth lifecycle under
  `/api/auth/*`: sign-in, sign-up, sign-out, get-session,
  request-password-reset, reset-password, verify-email, and change-password.
- Add the optional `X-Workspace-ID` request header to every authenticated
  `/api/v1` operation; the server resolves the caller's org_members membership
  and role for the selected workspace before it becomes the actor/RLS claims.
- Add the native workspace lifecycle: `POST /workspaces`,
  `PATCH /workspaces/{workspaceId}`,
  `POST /workspaces/{workspaceId}/invitations`,
  `POST /workspace-invitations/{token}/accept`,
  `DELETE /workspaces/{workspaceId}/invitations/{invitationId}`,
  `PATCH /workspaces/{workspaceId}/members/{memberId}`, and
  `DELETE /workspaces/{workspaceId}/members/{memberId}` with the
  `admin`/`member` role domain.
- Add `GET /assets/{asset_id}/preview-url` so validated ready media can be
  rendered from a short-lived private URL without weakening the existing
  attachment-only download response.
- Add explicit `403` responses for checkout and portal session commands, which
  require an active organization administrator.
- Add the Post-owned media composition surface: `GET /posts`, `POST /posts`,
  `GET /posts/{post_id}`, `PATCH /posts/{post_id}`, `DELETE /posts/{post_id}`,
  and `POST /posts/{post_id}/schedule` (`listPosts`, `createPost`, `getPost`,
  `updatePost`, `deletePost`, `schedulePost`). One durable `Post` owns its
  default text, ordered `attachments`, saved per-Channel `targets`, and
  independent `distributions`; a draft persists without any Channel
  selection, and scheduling or publishing preserves the same Post identity.
- Require `brand_profile_id` and an `Idempotency-Key` on every Post mutation,
  and reject attempts to persist a Post with neither text nor attachments.
  `POST /posts/{post_id}/schedule` accepts a nullable `scheduled_at` (null
  publishes immediately) and creates or updates only still-editable pending
  Distributions, leaving claimed, published, and reconciliation-bound
  outcomes unchanged.
- Replace `Distribution.asset_id` with `Distribution.post_id`, filter
  `GET /distributions` by `post_id`, and carry `post_id` on
  `CalendarEvent` (as `post_id`/`post_title`), `AnalyticsSnapshot`, and
  `InboxComment`.
- Add nullable `Distribution.publication`: the immutable frozen snapshot of
  the newest claimed publish attempt (`DistributionPublication` with title,
  text, hashtags, provider options, and ordered media identities), null until
  an attempt claims the Channel.
- Add `PlatformCapability.max_media_count`, `min_media_count`, and
  `multi_asset_types` as the authority for per-Channel attachment bounds;
  `AssetType` is now `image|video`, so text-only permission is expressed by
  `min_media_count`.
- Narrow `Asset` to post-owned media by dropping `text_content`,
  `description`, and `tags`; `CreateUploadSessionRequest` drops `description`
  and `tags` and keeps its required `title`. Accepted upload formats and size
  limits are unchanged.
- Remove the standalone media library and asset-centric composition
  contracts without replacement shims: `GET /assets`, `POST /assets`,
  `POST /assets/upload-url`, `DELETE /assets/{asset_id}`,
  `POST /distributions`, and `POST /distribution-batches`. Assets remain
  reachable only through the required scoped composer, preview, download,
  and upload-session operations, and abandoned media is reclaimed by
  ownership-aware orphan cleanup rather than a user-facing delete.

## 1.0.0-target.0 - 2026-07-18

- Publish the initial target `/api/v1` contract for the Cloudflare API Worker
  and generated frontend client.
- Define normative authentication, error, pagination, idempotency, asset,
  distribution, provider, analytics, inbox, and billing behavior.
- Mark the existing `POST /assets/upload-url` route as a temporary deprecated
  compatibility operation; new clients use asset upload sessions.
