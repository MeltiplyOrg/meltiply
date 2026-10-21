# Provider Channel connection contracts

Research date: 2026-10-21. Scope: the five implemented Providers' authorization,
account discovery, explicit Brand Profile assignment, and reconnection. This is
not evidence of live third-party authorization or publishing acceptance.

## Shared application contract

`packages/providers/src/index.ts` registers Facebook, Instagram, Threads, TikTok,
and YouTube. `workers/api/src/core-routes.ts` sends every successful exchange to
`/channels/connect`, including a single-account grant. Candidates are encrypted
in the OAuth state coordinator; only sanitized account metadata reaches the
browser. Confirmation binds the selected external account to an eligible Brand
Profile through `saveOAuthConnectionEffect`. A profile owns at most one Channel
per Platform, and an external account cannot be attached to two profiles.

The assignment list restricts an already-connected account to its current owner,
not every profile with an empty Platform slot. Durable confirmation claims fence
the requested Brand Profile while a save may still be in flight. Completed replay
requires the same account, Brand Profile, and idempotency key; a changed destination
returns 409 rather than claiming an assignment that did not happen. A deterministic
failed save releases its claim so another eligible profile can be chosen.

Facebook business-user Page edges use at most four concurrent requests, with
sequential pagination within each edge and shared 1,000-request/record bounds.
Results are merged in discovery order, preserving deterministic Page deduplication
regardless of response timing. Failed discovery stops new work and drains in-flight
requests before rejecting; this is not a measured live-provider latency claim.

## Instagram

Use Instagram Login, not Facebook's Page enumeration. Meta's
[Business Login contract](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
uses `www.instagram.com/oauth/authorize`, `api.instagram.com/oauth/access_token`,
and `graph.instagram.com/access_token`. It documents a short-token response in a
single-entry `data` array, with `access_token`, app-scoped `user_id`, and granted
`permissions`. `force_reauth=true` lets users authenticate another professional
account rather than silently reusing the browser's Instagram session.

The [Instagram Login getting-started contract](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
distinguishes `id` (app-scoped identity) from `user_id` (professional account ID,
also used by webhooks). It documents `Business` and `Media_Creator` account types
and a `data`-wrapped profile response. The
[User node reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user)
also describes flat Graph node responses. Both shapes must be decoded without
confusing their identity fields. An empty or multiple-entry account envelope
cannot establish the single account authorized by Instagram Login.

Confirmed source gaps in `packages/providers/src/instagram.ts`: only flat
responses were decoded; the connection retained app-scoped `id` rather than
professional `user_id`; account-type checks only accepted uppercase spelling;
the browser was not explicitly allowed to reauthenticate another account.
Explicitly returned partial permission grants must not be recorded as complete.

Instagram Login authorizes the signed-in professional account; it is not an API
for listing all Instagram accounts managed by a Facebook user. Connect another
account through another authorization. Advanced Access/App Review is required
when serving professional accounts outside the app's own managed/test accounts.
Long-lived tokens last approximately 60 days and can be refreshed only while
unexpired and at least 24 hours old, per the Business Login contract above.

## Threads

The current [authorization contract](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions)
uses `threads.com/oauth/authorize` and `graph.threads.com/oauth/access_token`.
The [long-lived-token contract](https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens)
requires `access_token` as a query parameter on the exchange and refresh
endpoints, alongside `th_exchange_token` / `th_refresh_token`.

Confirmed source gaps in `packages/providers/src/threads.ts`: old `.net` hosts
were still used, and exchange/refresh supplied only an Authorization header
instead of the documented token parameter. The HTTP client rejects redirects,
so relying on an old host redirect is not a valid migration strategy.

The [profile contract](https://developers.facebook.com/documentation/threads/threads-profiles)
allows fetching only the app-scoped token subject. This is a single-account
connection, not a Page directory. Use the profile's string `id`; the documented
numeric token-response `user_id` can exceed JavaScript's safe integer range.
The [delete contract](https://developers.facebook.com/documentation/threads/posts/delete-posts)
requires `threads_delete`, so that scope must remain while cancellation is
implemented. Long-lived grants require the same 24-hour/unexpired refresh
conditions as documented above. Non-test app users require the relevant Meta
access approval; a local acceptance flag does not grant provider permissions.

## TikTok

The [web token contract](https://developers.tiktok.com/doc/oauth-user-access-token-management)
uses form-encoded `POST /v2/oauth/token/`. PKCE's `code_verifier` is required for
mobile/desktop clients, not this web-server flow. Access tokens last 24 hours;
refresh tokens can rotate and the returned replacement must be stored.
[User Info](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info)
returns one `data.user`, whose `open_id` must match the token subject.
`user.info.basic` covers the requested identity, display name and avatar;
`video.publish` authorizes Direct Post. Existing adapter behavior follows these
contracts; no Facebook-style account-list endpoint should be invented.

The [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
require a verified domain/URL prefix for PULL_FROM_URL media. Unaudited clients
have private-viewership/user restrictions. The guidelines explicitly exclude
an internal-only uploader as an acceptable audit use case. A self-hosted
installation must not assume arbitrary private apps will receive public Direct
Post approval. These are TikTok policies, not community resource quotas.

## YouTube

[channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
returns a collection and supports `mine=true`, pagination and `maxResults` up to 50. That read contract alone is not permission to upload to any returned or
publicly discovered channel. [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
uploads to the channel associated with the request. Its channel-targeting
`onBehalfOfContentOwnerChannel` parameter is restricted to YouTube content
partners using a linked CMS/content owner. `snippet.channelId` is not among the
writable upload properties.

Decision: retain this integration's exactly-one-authorized-channel guard. Do not
present a list of channels using the same ordinary token while pretending a
chosen ID selects the upload destination. Zero, multiple, or paginated channel
results fail explicitly with `youtube_channel_selection_required`. Another
channel requires another Google/YouTube authorization, choosing the appropriate
personal or Brand Account. [Google's channel ownership guide](https://support.google.com/youtube/answer/4642409)
explains how one Google account can manage separate Brand Accounts.

The existing adapter requests offline access, consent, PKCE S256, upload and
read-only scopes, requires a refresh token at initial connection, and preserves
it when a refresh response omits a replacement. Deployment still needs its own
Google consent-screen access, registered exact redirect URI and permitted test
users or production verification. App configuration is not proven by fixtures.

## Verification boundary

Provider unit tests use documented external wire responses, not mocked adapter
returns. The hosted `cloudflare-full` lane additionally runs
`scripts/selfhost/oauth-connection-check.ts`: real API handlers, SQLite-backed
OAuth state, encryption and PostgreSQL persistence, with only authentication
and external provider HTTP responses controlled. It exercises all five
Platforms through authorization state, metadata, explicit assignment,
idempotent replay, reconnect and cancellation. This cannot prove app review,
live consent, real account permissions, or successful publication to a real
social account. Those remain explicit live-provider acceptance checks.

### Observed results

The [failing-before hosted run](https://github.com/MeltiplyOrg/meltiply/actions/runs/39642629160)
reproduced three regressions against the previous implementation: Instagram
exchange, Threads exchange, and Threads refresh.

The [passing full-gate run](https://github.com/MeltiplyOrg/meltiply/actions/runs/39645278404)
at `ce7a9a2d6313eee1b8a16e5bc9215fc92bdf843c` passed all five connection smoke
flows, the self-hosted script type-check, and `bun run cloudflare:check`.
No live third-party OAuth credentials or consent sessions were used.
