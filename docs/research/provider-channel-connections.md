# Provider Channel connection contracts

Research date: 2026-10-21. Scope: the five implemented Providers' authorization,
account discovery, explicit Brand Profile assignment, and reconnection. Hosted
contract checks and later operator-confirmed live connections are distinguished
below; neither establishes live publishing acceptance.

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

Live verification on 2026-10-22 exposed another contract difference: the token
response supplied `permissions` as an array, with all four configured permissions
granted. The string-only decoder incorrectly raised `instagram_permissions_missing`
after the token exchange had succeeded. Decode both this live array shape and
Meta's documented comma-separated string; array entries must be non-empty bounded
strings and every configured permission remains required. Do not bypass the grant
check or disable engagement to work around the representation difference.

The [Instagram Login getting-started contract](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
distinguishes `id` (app-scoped identity) from `user_id` (professional account ID,
also used by webhooks). It documents `Business` and `Media_Creator` account types
and a `data`-wrapped profile response. The
[User node reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user)
also describes flat Graph node responses. Both shapes must be decoded without
confusing their identity fields. An empty or multiple-entry account envelope
cannot establish the single account authorized by Instagram Login.

The next live callback on 2026-10-22 passed every profile-field check but exposed
an incorrect equality requirement between the token response's `user_id` and the
profile's app-scoped `id`. Neither profile ID matched that token-response value.
Do not infer the cause of the different values from this observation. The
getting-started contract defines `/me` as the account represented by its access
token: resolve identity from that authenticated profile and retain its professional
`user_id`, without joining IDs across the two responses. Keep structural ID,
professional account-type, permission, and avatar URL validation.

After this correction, the operator confirmed that Facebook, Instagram, and
Threads connections work in the live local environment. This confirms connection
acceptance only, not publishing, analytics, comments, or production deployment.

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

The [web authorization contract](https://developers.tiktok.com/doc/login-kit-web)
documents `disable_auto_auth=1` to always show the authorization page instead of
silently reusing a valid session's authorization. Connection now supplies this
parameter, so connecting another Channel does not silently skip that step.
The web flow intentionally does not send the mobile/desktop-only PKCE verifier.

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

The adapter requests offline access, account selection and consent, PKCE S256,
upload and read-only scopes, requires a refresh token at initial connection, and preserves
it when a refresh response omits a replacement. Deployment still needs its own
Google consent-screen access, registered exact redirect URI and permitted test
users or production verification. App configuration is not proven by fixtures.

[Google's web-server OAuth contract](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth)
allows incremental authorization to combine grants made by other clients of the
same API project, including `openid` and `profile`. The old URL-only scope decoder
rejected these otherwise valid grants. Decode bounded
[OAuth scope tokens](https://www.rfc-editor.org/rfc/rfc6749#section-3.3), not just
HTTPS URLs, while still requiring both configured YouTube scopes. The same
decoder handles refresh responses. `prompt=consent select_account` preserves
offline consent and explicitly offers account choice.

Before live connection, configure each app's credentials and register these exact
callback paths under the deployment's public **API** origin:

| Platform | Required configuration                                                                                                                                     | Callback path                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| TikTok   | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`; Login Kit and `user.info.basic,video.publish` access                                                          | `/api/v1/platforms/tiktok/callback`  |
| YouTube  | `YOUTUBE_SHORTS_CLIENT_ID`, `YOUTUBE_SHORTS_CLIENT_SECRET`; Google Web application client, enabled YouTube Data API v3, and permitted consent-screen users | `/api/v1/platforms/youtube/callback` |

TikTok's media prefix defaults to
`<APP_URL>/api/v1/provider-media/`. Leave `TIKTOK_MEDIA_URL_PREFIX`
unset or blank for this default; API startup and release validation do not require
an override. A nonblank override must be an exact HTTPS directory prefix with a
trailing slash and must cover the media URLs emitted by the API. This setting
does not change where Meltiply hosts media. The matching domain or URL prefix
must still be verified in TikTok's developer portal; derivation does not perform
or bypass verification.

The [hosted configuration smoke](https://github.com/MeltiplyOrg/meltiply/actions/runs/39910725878)
at `12b62be` exercised connection and refresh with no explicit prefix, then real
adapter Direct Post validation with blank/default and explicit override prefixes.
Media outside the selected prefix was rejected before provider HTTP; external
TikTok responses were controlled, not live publishing.

`TIKTOK_LIVE_ACCEPTED` and `YOUTUBE_LIVE_ACCEPTED` remain explicit deployment
activation controls; tests do not enable them in an operator's `.env`. Never
treat fixture credentials or a passing hosted gate as provider app approval.

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

The [2026-10-22 full-gate run](https://github.com/MeltiplyOrg/meltiply/actions/runs/39716428009)
at `55ccd63` passed the corrected Instagram grant regression tests, all five
connection lifecycles with real SQLite state and PostgreSQL persistence,
`bun run cloudflare:check`, and the focused assignment/navigation browser journey.
The connection smoke now uses Instagram's observed permission-array format.
External provider HTTP responses remain controlled in that smoke; the hosted
result alone cannot certify live authorization. The operator's later live
connection confirmation is recorded in the Instagram section above.

The [profile-identity correction full gate](https://github.com/MeltiplyOrg/meltiply/actions/runs/39798038864)
at `5be419a` passed the grant/profile identity regressions, the five-Platform
connection smoke with distinct Instagram token and profile IDs,
`bun run cloudflare:check`, and the assignment/navigation browser journey.

The [YouTube/TikTok connection gate](https://github.com/MeltiplyOrg/meltiply/actions/runs/39804649567)
at `12a95e8` passed provider regressions, `bun run cloudflare:check`, the
assignment/navigation browser journey, and the expanded real-state connection
smoke. It exercises both providers' forged-state and denied-consent callbacks
without any token exchange. Successful flows exercise assignment, reconnect,
cancellation, and automation refresh against encrypted PostgreSQL credentials.
TikTok's replacement
refresh token is persisted; Google's existing refresh token survives an omitted
replacement; replaying the old refresh event does not exchange another token.
Google's token responses in this smoke include non-URL incremental grants.
External OAuth/profile responses remain controlled; live TikTok/YouTube consent
and provider app configuration have not been accepted.
