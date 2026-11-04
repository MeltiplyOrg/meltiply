# Publishing flow: source comparison and completion

Research dates: 2026-10-28 (source comparison), 2026-10-29 (official protocol and
video-workflow audit), and 2026-11-03 (local five-provider Postiz comparison).
Source review and local protocol fixtures are not live-platform acceptance.
No third-party publishing credentials, platform audit, or real public post was used.

## References inspected

- Postiz commit `a5affe62c74e39c1e7ac960d50d8418b807d532c`:
  [publication activity](https://github.com/gitroomhq/postiz-app/blob/a5affe62c74e39c1e7ac960d50d8418b807d532c/apps/orchestrator/src/activities/post.activity.ts),
  [missed-post sweep](https://github.com/gitroomhq/postiz-app/blob/a5affe62c74e39c1e7ac960d50d8418b807d532c/apps/orchestrator/src/workflows/missing.post.workflow.ts),
  [YouTube controls](https://github.com/gitroomhq/postiz-app/blob/a5affe62c74e39c1e7ac960d50d8418b807d532c/apps/frontend/src/components/new-launch/providers/youtube/youtube.provider.tsx),
  [TikTok controls](https://github.com/gitroomhq/postiz-app/blob/a5affe62c74e39c1e7ac960d50d8418b807d532c/apps/frontend/src/components/new-launch/providers/tiktok/tiktok.provider.tsx).
- Mixpost commit `df57648b866310446703f5294350552b62735df5`:
  [due-post scan](https://github.com/inovector/mixpost/blob/df57648b866310446703f5294350552b62735df5/src/Commands/RunScheduledPosts.php),
  [fan-out](https://github.com/inovector/mixpost/blob/df57648b866310446703f5294350552b62735df5/src/Actions/PublishPost.php),
  [account job](https://github.com/inovector/mixpost/blob/df57648b866310446703f5294350552b62735df5/src/Jobs/AccountPublishPostJob.php),
  [account result persistence](https://github.com/inovector/mixpost/blob/df57648b866310446703f5294350552b62735df5/src/Actions/AccountPublishPost.php).
- Official [TikTok Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines),
  [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert),
  and [YouTube video status fields](https://developers.google.com/youtube/v3/docs/videos#status.selfDeclaredMadeForKids).

## Comparison

| Concern                       | Observed reference behavior                                                                                                                                   | Meltiply decision                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Due work                      | Mixpost scans scheduled/pending Posts at or before UTC now. Postiz periodically searches missed Posts and starts/signals their existing workflow identity.    | Retain durable schedules, Due work, Outbox, and existing recovery scanner. A transport message is not the record of scheduling intent.           |
| Fan-out                       | Mixpost dispatches one job per account with `allowFailures`, saves account-specific errors/provider results, then derives aggregate status.                   | Retain independently tracked Distributions. Do not overwrite a successful Channel because another failed.                                        |
| Asynchronous publication      | Postiz separates `postPending`, `checkPostStatus`, and `finalizePost`; follow-up notification failures must not republish already-created content.            | Retain operation identities, Awaiting provider, Reconciliation, and provider polling. Submission alone is not Published.                         |
| Rate limits and authorization | Mixpost refuses inactive/unauthorized accounts, releases rate-limited jobs using provider delay, and saves terminal failures per account.                     | Retain connection validation, bounded retries/backoff, leases, and dead-letter routing.                                                          |
| Cancellation                  | Mixpost account jobs stop on cancelled batches or historical Posts.                                                                                           | Retain stronger local safety: cancel pending work, request cancellation for in-flight work, preserve published copies and uncertain outcomes.    |
| YouTube metadata              | Postiz exposes title, Public/Private/Unlisted, Made for kids, and tags. Google documents writable `status.selfDeclaredMadeForKids`, not `status.madeForKids`. | Expose and round-trip existing contract audience/visibility options; correct Google's upload field without changing Meltiply's public API.       |
| TikTok creator choices        | Postiz exposes privacy/interactions/disclosures, but its static privacy list and some defaults are not proof of compliance with current TikTok requirements.  | Follow official creator-scoped requirements instead of copying reference defaults. No invented privacy fallback or automatic interaction opt-in. |

The inspected references were read, not deployed. Their implementation demonstrates
patterns, not a guarantee that every provider integration works or is audited.
No source code was copied.

## Confirmed gaps

1. YouTube's composer wrote only title/tags despite an existing API contract for
   audience and visibility. Its adapter serialized the audience declaration as
   `madeForKids`; Google lists `selfDeclaredMadeForKids` as the writable field.
2. TikTok showed all static privacy levels before creator requirements loaded,
   defaulted Comments/Duet/Stitch on, and showed video-only interactions for photos.
3. TikTok omitted its visible Music Usage Confirmation declaration and branded
   content policy guidance. Commercial content needed the explicit disclosure
   gate and required subtype selection described by TikTok.
4. Creator requirements must gate submission when unavailable, identify the actual
   creator, and apply per-target media rules rather than the Post's combined media.
5. Reopening a manually scheduled Post restored its time but selected Draft.
   Its primary save could therefore cancel pending delivery. Restore Schedule
   intent from a pending scheduled Distribution, independently of historical dates.

## Meta protocol cross-check

- [Instagram content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
  separates container creation, readiness (`status_code`), and `media_publish`.
  Images must be JPEG and provider retrieval needs an accessible media URL.
  Meltiply accepts up to 20 carousel items, single-image/video feed containers,
  Reels/trial Reels, and photo/video Stories. Stories reject captions/signatures.
  This connection uses Instagram Login, not Facebook Login-only publishing APIs.
- [Threads posts](https://developers.facebook.com/documentation/threads/posts)
  uses `threads` then `threads_publish`, requires explicit media discriminators
  (including carousel children), and supports up to 20 carousel attachments.
  Advanced publishing access is separate from test-user access. Existing adapter
  tests cover readiness, ordered children, and ambiguous final writes.
- [Facebook Reels publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)
  uses start, hosted-file upload, processing/status lookup, then finish.
  Pages have Public scope. Feed text/links/photos, regular video, Reels, Stories,
  slideshows, crossposts, native drafts, video experiments, and Live each use
  their own endpoint and completion evidence; none falls back to a Reel.

All three remote-ingest paths require provider-reachable media. Meltiply issues
signed bearer delivery URLs only when dispatching an attempt and holds its frozen
objects through the retrieval window (`provider-media.ts` and `distribution.ts`).
No test substitutes a private bucket path for an externally fetchable URL.
Protocol tests control provider HTTP; live networking and account approval remain
separate acceptance requirements.

## End-to-end acceptance contract

- Draft saving requires neither Channels nor publishing-ready media. Saved targets
  and ownership survive reopen. Queue, Schedule, and Now use the same delivery path.
- Queue assigns a future timezone-aware reservation; manual Schedule uses the
  chosen instant; Now accepts immediate delivery, never optimistic publication.
- Each target validates its actual caption, attachment subset, provider options,
  connection and verified rendition before provider submission.
- A Provider attempt freezes content/media. At-least-once messages cannot publish
  a second copy; uncertain writes reconcile instead of retrying blindly.
- Independent successful/failed/processing outcomes persist after reload. Retry
  acts only on an eligible failure. Cancellation/deletion never unpublishes copies.
- YouTube audience/visibility and TikTok creator choices must survive save/reopen
  and reach the provider boundary. The actual adapters retain protocol tests for
  remote processing, resumable upload, media constraints and ambiguous outcomes.
- Browser acceptance crosses the actual API, PostgreSQL, R2, media processor,
  transport queue and automation consumer, with a controlled external Provider.
  It cannot establish real Meta/TikTok/Google acceptance.

Saved Post options and complete Distribution publication options have distinct
contracts. Drafts retain unanswered YouTube audience/TikTok privacy and the
commercial-disclosure gate even without a selected subtype. Scheduling rejects
incomplete choices and strips the draft-only disclosure gate before delivery.

## Official video protocol audit

The publishing model separates public publication from native handoff.
Now, Schedule, and weekly Queue are Meltiply delivery intents: future work stays
durable locally and starts the same Provider protocol when due. Containers are not
created at draft-save time or held until a future publication date.

| Platform  | Supported paths and official completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Facebook  | [Page feed](https://developers.facebook.com/documentation/pages-api/posts), regular video, [Reels](https://developers.facebook.com/documentation/video-api/guides/reels-publishing), [Stories](https://developers.facebook.com/documentation/video-api/page-stories-api), slideshows, crossposts, experiments, and [Live](https://developers.facebook.com/documentation/live-video-api/guides/streaming). Reels retain their session/upload/finish status evidence. Photo/video Stories use their own endpoints. A native Page draft, created experiment, or prepared broadcast is `delivered`, not public publication. An actual Live/VOD status can prove publication later. |
| Instagram | [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing): feed image/video, mixed carousel up to 20, Reel/trial Reel, and Story. `FINISHED` permits finalization; `PUBLISHED` proves completion without inventing a lost media ID. Reels use the 300 MB ceiling and Stories 100 MB; feed videos and carousel children retain the app's 500 MiB upload ceiling. Image alt text/tags stay on the correct child.                                                                                                                                                                                                                 |
| Threads   | [Posts](https://developers.facebook.com/documentation/threads/posts): standard media/carousels, polls, long text, GIPHY GIFs, ghosts, quotes, replies, and source-ID reposts. Media containers wait for readiness before finalization; ambiguous final writes are not blindly repeated. Optional Instagram Story cross-sharing failure is retained as a warning without erasing the successful Threads Post or retrying it.                                                                                                                                                                                                                                                    |
| TikTok    | [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post) queries current creator information. Video/photo inbox handoffs instead use `video.upload` and native completion. Both ingest through verified HTTPS URLs and [poll the retained ID](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status). `PUBLISH_COMPLETE` proves direct publication; `SEND_TO_USER_INBOX` is terminal `delivered` only for the inbox method, never a public Post ID.                                                                                                                                                       |
| YouTube   | Ordinary videos and Shorts share [resumable upload](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol); no portrait/180-second app restriction remains. Processing is polled after acceptance. [Live broadcast creation](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert) creates and binds a separate RTMPS stream for an external encoder. A prepared broadcast is `delivered`; actual provider lifecycle proves live/public state. Ending an unstarted broadcast deletes it without claiming a recording.                                                                                                          |

The audit fixed Facebook completion/failure-state handling, Instagram completion
after an ambiguous final write and its oversized Reel allowance, TikTok terminal
failure classification, stale creator requirements, and missing Facebook audience
disclosure. Protocol regressions exercise the actual adapters with controlled HTTP;
they do not substitute a controlled adapter for those protocol assertions.

### Video acceptance scenarios

`posts-publication.spec.ts` contains one five-Platform by three-mode journey:

| Platform                 | Now   | Manual Schedule | Weekly Queue |
| ------------------------ | ----- | --------------- | ------------ |
| Facebook Page Reels      | Video | Video           | Video        |
| Instagram Reels          | Video | Video           | Video        |
| Threads                  | Video | Video           | Video        |
| TikTok Direct Post       | Video | Video           | Video        |
| YouTube Shorts candidate | Video | Video           | Video        |

Every composition saves and reopens its draft before submission. The scheduled
composition is edited and its instants remain unchanged. Future work reaches
wall-clock due times; no database rewrite or future clock makes it eligible.
Assertions require all 15 Channel outcomes to become Published after reload,
independent Provider-side copies, retrieved media checksums/lengths, selected
YouTube/TikTok options, no early delivery, and no duplicate copies after repeat
dispatcher ticks. Separate video journeys cover Queue failure/backoff, safe removal
and retained history, multi-profile partial-save/submission recovery, and deletion
of a scheduled video without changing earlier published copies.

The committed `composer-publish.mp4` fixture is four seconds, 540×960 portrait,
30 fps H.264/yuv420p, stereo AAC at 48 kHz and 128 kbps, fast-start MP4 without
edit lists. It was generated and fully decoded on a GitHub-hosted runner.
The tiny one-second processor fixture is not suitable publication evidence for
Meta's three-second minimum or TikTok's size/frame-rate requirements.

[Facebook's guide](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)
specifies 3–90 seconds, 9:16, at least 540×960 and 24–60 fps; the application
supports that 90-second Reel ceiling. Instagram specifies 3–900-second Reels and
23–60 fps. Threads allows positive durations up to 300 seconds and 23–60 fps.
[TikTok's transfer guide](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)
requires 360–4096 pixels per dimension and 23–60 fps, plus the creator-specific
duration ceiling. Media processing is not a promise to make every arbitrary upload
Platform-compliant; remote validation failures remain visible delivery failures.

Meta and TikTok fetch externally reachable media asynchronously. TikTok additionally
requires verified HTTPS ownership, no redirects, and availability for its download
window (up to one hour). Meltiply's existing provider-media lease is 24 hours and
starts at dispatch, not draft save or scheduling. The browser's byte-upload
controlled Provider proves stored media delivery, not external URL reachability.

## Platform constraints outside application verification

TikTok requires creator information when rendering its posting UI, privacy selected
without a default, unchecked interaction controls, hidden Duet/Stitch for photos,
commercial disclosure guidance, visible policy consent, a content preview and status
polling. Its guidelines also restrict unaudited clients to private posting and
explicitly exclude an internal-only uploader as an acceptable audit use case.
A working implementation cannot remove those platform restrictions. PULL_FROM_URL
needs a verified HTTPS domain/prefix. See the official guidelines above and the
[connection research](provider-channel-connections.md) for deployment prerequisites.

Live acceptance flags remain operator controls. Automated checks must not enable
them or claim that a test double proves credentials, approval, media reachability,
or real account publication.

## Local Postiz comparison — 2026-11-03

The reference was cloned locally from `https://github.com/gitroomhq/postiz-app.git`
and pinned to `e424fb587e0ae87a2428a0586cb00af6facd0d1d`.
The comparison followed container creation, media transfer, finalization,
provider-side processing, identifiers, and partial-success handling. No reference
source was copied into Meltiply.

| Provider  | Pinned publishing reference                                                                                                                                                                                                                                                                                                                                                       | Verified result and correction                                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Facebook  | [Page provider](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/facebook.provider.ts)                                                                                                                                                                                                    | Feed-photo staging, regular videos, and Story endpoint order agree. No additional Facebook defect was established. Postiz does not implement all of Meltiply's Reel, slideshow, crosspost, experiment, native-draft, or Live paths, so it cannot validate those methods.                                                                                                             |
| Instagram | [Shared publishing](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/instagram.provider.ts), [Instagram Login](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/instagram.standalone.provider.ts) | Accept the documented single-account `/me` envelope; enforce three collaborators in the API, adapter, and composer; retain a published media ID with `instagram_publish_partial` when Instagram reports lost caption, tags, or caption add-ons.                                                                                                                                      |
| Threads   | [Threads provider](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/threads.provider.ts)                                                                                                                                                                                                  | Text and provider-hosted content now use the same durable readiness gate as media. A matching published media ID no longer fails because Meta omits a permalink. Additional literal hashtags are allowed; only the first becomes a native topic tag.                                                                                                                                 |
| TikTok    | [Content Posting provider](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts)                                                                                                                                                                                           | Direct/inbox endpoints, current creator choices, AI disclosure, terminal handoff, and exact 64-bit Post IDs agree. Photo resolution uses the reference's 1080p short-side interpretation instead of rejecting every portrait image taller than 1080 pixels. TikTok documents “1080p” without an explicit per-axis photo ceiling; real-account acceptance remains necessary.          |
| YouTube   | [YouTube provider](https://github.com/gitroomhq/postiz-app/blob/e424fb587e0ae87a2428a0586cb00af6facd0d1d/libraries/nestjs-libraries/src/integrations/social/youtube.provider.ts)                                                                                                                                                                                                  | Preserve Google's complete resumable-session URI through interruption and fresh-adapter recovery; do not reconstruct its opaque query. An expired processing record (`terminated`) is not a failed upload. Live creation uses a future start time rather than an instant already expired in transit. Remove the unsupported `maxResults` parameter from an ID-filtered video lookup. |

Primary documentation resolves disagreements with the reference:

- [Instagram media creation](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
  specifies three collaborators, despite Postiz accepting five.
- [Instagram media publishing](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish)
  explicitly treats `config_issue` and `caption_add_on_attachment_status` as
  successful publication with missing content. Migration
  `030_instagram_partial_publication_warning.sql` extends the existing closed
  warning vocabulary without permitting arbitrary provider payloads.
- [Threads retrieval](https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/replies-and-conversations)
  documents copyright-related permalink omission; absence is not proof of a
  failed Post. A present malformed URL still fails validation.
- [Threads Posts](https://developers.facebook.com/documentation/threads/posts)
  documents first-valid-tag conversion, not rejection of all additional literal
  hashtags. Polling retains the same container and never creates a replacement.
- [YouTube processing details](https://developers.google.com/youtube/v3/docs/videos#processingDetails.processingStatus)
  defines `terminated` as information no longer available. Publication still
  requires an independent `processed` upload status.
- [YouTube Live insertion](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert)
  requires a future `scheduledStartTime`; a one-minute creation margin does not
  replace the external encoder or prove that the broadcast is live.

### Deliberate differences and unproven findings

- Retain queue-backed polling and `created`/`submitted` identities instead of
  Postiz's in-request polling loops. Never substitute a container ID or a profile
  URL for missing published-media evidence, and never republish an ambiguous
  final write.
- Keep each Distribution's single Story outcome. Postiz's sequential multi-Story
  loop returns only its last media ID and is not a safe model for independently
  recoverable outcomes.
- Instagram's documented carousel creation sequence permits collecting child
  IDs and creating the parent before polling its readiness. A claim that every
  child must first be `FINISHED` was not established; no speculative blocking
  loop was added.
- `enable_fb_login=false` is a sign-in presentation choice. Meta's
  [Instagram Login guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
  documents the enabled option as the default; there is no evidence that leaving
  it enabled changes this integration into the Facebook Login API product.
- Album-child permalink limitations do not establish an Instagram bug in a
  lookup of the published parent. Analytics-only metric/period concerns and the
  combination of trial Reels with feed sharing were not verified as publishing
  failures and were not changed.
- Threads' unversioned resource paths and mixed-script/ZWJ character accounting
  still need live-account confirmation. The documentation says emoji use UTF-8
  bytes but links a grapheme counter; no guessed stricter limit was introduced
  for ordinary non-ASCII text. Carousel-level versus per-item Threads alt text
  also remains an acceptance question.
- Postiz is not an option-for-option parity target: TikTok Business API is a
  separate connection product, FILE_UPLOAD is a transfer alternative to the
  supported verified-URL path, and custom YouTube thumbnails are optional
  post-upload metadata not exposed here. WebM remains outside Meltiply's upload
  contract; existing MP4/MOV video methods are unchanged. The application's
  upload ceiling and bounded internal operation identity also remain in force.

### Local evidence and limits

- `bun run contract:check` passed, including collaborator boundaries and closed
  composed Threads schemas.
- `bun x vp run --filter './packages/*' --filter './workers/*' --concurrency-limit 1 type-check`
  passed across all 11 projects.
- The initial serial package/Worker test run had 1,028 passing tests, including
  all 352 Provider tests, and five opt-in live-Worker skips, but failed the API
  function-coverage gate at 53.51% versus 55%.
- After adding broadcast HTTP cases for authorization, connection state, secret
  handling, upstream failures, and idempotent termination, the API unit stage
  passed all 299 tests with 56.61% function coverage. The 55% threshold remains
  unchanged. That exposed missing `getBroadcast`/`endBroadcast` conformance cases;
  after adding them, `bun run --filter @meltiply/api-worker test:contract` passed
  all 267 tests.
- `node --test scripts/ci/integration-database.test.mjs` passed all three routing
  guard cases. Strict type-aware lint passed on the changed Provider/runtime,
  contract-test, and routing-helper files.
- `bun run --filter frontend-app check` passed: 735 tests, formatting, Cloudflare
  binding generation, TypeScript, lint, and the production build.
  `bun run --filter frontend-app build:ui-preview` also passed. Chromium exercised
  the actual collaborator input and Published partial-content warning at
  1440×1000 and 390×844 in light/dark palettes; the warning did not expose a
  Retry action, and the phone document had no horizontal overflow.
- `bun run lint:dead` passed after keeping the internally used `threadsMethod`
  helper private. `bun run format-check:cloudflare` and the final frontend
  TypeScript check passed.
- The initial unresolved `miniflare` and `pg` types came from missing dependencies
  in the separate self-host npm package. After
  `npm ci --prefix scripts/selfhost --include=dev`, repository-wide `bun run lint`,
  `bun run lint:dead`, and API type-checking passed without dependency-manifest,
  coverage-threshold, or lint-rule changes. The actual `storage:s3:check` script
  also passed against an isolated local Miniflare S3 gateway.
- `bun run i18n:check` passed all seven target locales with zero errors/warnings.
  The worktree's surviving Git registration was reconnected without resetting or
  checking out source files. `bun run docs:links` then passed across 551 files and
  1,451 local links.
- The full `test:integration` gate passed against disposable PostgreSQL on port
  55483: 27 database, 210 API, and 110 automation tests. The real Instagram
  adapter's partial-success path persisted Published plus a warning and ignored
  a later publish trigger; its final upstream write occurred once.
- A throwaway TCP HTTP smoke exercised the real five adapters in seven scenarios:
  staged Facebook photos, Instagram partial success, deferred Threads text plus
  missing permalink, TikTok portrait photo and inbox video, YouTube resumable
  MP4/expired processing metadata, and future-dated Live handoff. It transferred
  the real 74,580-byte MP4 and 15,377-byte portrait JPEG and observed exactly one
  Instagram and one Threads finalizing write. It did not contact those providers.
- The initial local integration attempt exposed fixtures hard-coding system/admin
  connections to port 5433 while authenticated queries used the disposable
  target. Some setup/cleanup operations could reach the existing development
  database; that run is not product evidence. All fixture roles now derive from
  the selected loopback database URL, and explicit privileged overrides cannot
  silently change its host, port, or database. The passing run above used only
  the disposable target.

Local protocol fixtures do not establish account eligibility, app review, token
grants, verified public-media reachability, an actual encoder stream, or provider
acceptance of every method. Operator acceptance flags remain unchanged.
