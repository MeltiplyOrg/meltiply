# Publishing flow: source comparison and completion

Research dates: 2026-10-28 (source comparison), 2026-10-29 (official protocol and
video-workflow audit). Source review is not live-platform acceptance. No third-party
publishing credentials, platform audit, or real public post was used.

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
  The current guide describes up to 20 carousel items; Meltiply deliberately
  retains its documented, conservative 10-item subset on its configured API version.
  This is not support for every newer Instagram publishing feature.
- [Threads posts](https://developers.facebook.com/documentation/threads/posts)
  uses `threads` then `threads_publish`, requires explicit media discriminators
  (including carousel children), and supports up to 20 carousel attachments.
  Advanced publishing access is separate from test-user access. Existing adapter
  tests cover readiness, ordered children, and ambiguous final writes.
- [Facebook Reels publishing](https://developers.facebook.com/documentation/video-api/guides/reels-publishing)
  uses start, hosted-file upload, processing/status lookup, then finish.
  Pages have implicit Public scope. Meltiply supports Page Reels, not personal
  profiles, photo/feed posts, Stories, or the entire Facebook publishing API.
  Existing upload and lookup paths preserve the operation through those phases.

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

The supported paths are deliberately narrower than each Platform's whole API.
Now, Schedule, and weekly Queue are Meltiply delivery intents: future work stays
durable locally and starts the same Provider protocol when due. Containers are not
created at draft-save time or held until a future publication date.

| Platform  | Supported path and official completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facebook  | [Page Reels](https://developers.facebook.com/documentation/video-api/guides/reels-publishing): start a session, upload the hosted file to `rupload.facebook.com`, finish with `video_state=PUBLISHED`, then poll status. The documented publishing phase `completed` and the guide's example `complete` both prove completion. `expired` and `upload_failed` are terminal video failures. Pages have Public audience only; the composer exposes that sole choice and its sharing consequence.                                                                                                                                                                                                                                                                                               |
| Instagram | [Reels and ordered mixed carousels](https://developers.facebook.com/documentation/instagram-platform/content-publishing), retaining the application’s 10-item subset. Single videos use `REELS`; carousel videos use unpublished `VIDEO` children. [Container `FINISHED`](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container/) permits finalization; `PUBLISHED` proves completion even when the final response and media ID were lost. The adapter retains the operation identity rather than inventing a media ID. [The Reel ceiling is 300 MB](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media/); the adapter conservatively interprets this as 300,000,000 bytes. |
| Threads   | [Single videos and ordered mixed carousels](https://developers.facebook.com/documentation/threads/posts): create explicitly typed containers, wait for readiness, then call `threads_publish`. [Container status](https://developers.facebook.com/documentation/threads/troubleshooting/) distinguishes readiness, completion, expiry, and failure. Submitted ambiguous final writes are not blindly repeated.                                                                                                                                                                                                                                                                                                                                                                              |
| TikTok    | [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post): query [current creator information](https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info), initialize `PULL_FROM_URL`, and [poll the retained publish ID](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status). `PUBLISH_COMPLETE` proves publication; private/moderated posts may lack a public post ID. Terminal `internal`, `video_pull_failed`, and `photo_pull_failed` permit retry; `auth_removed` requires reconnection, not retry. The UI refreshes creator information on every mount, including immediate draft reopen, and does not authorize sending from cached data before that lookup succeeds.           |
| YouTube   | Square/portrait Shorts candidates up to the existing 180-second application ceiling. [Resumable upload](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol) retains the session and probes Google's acknowledged byte Range before resuming; interrupted chunks do not create another upload. [Writable upload metadata](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert) uses `status.selfDeclaredMadeForKids` and selected privacy. [Video processing status](https://developers.google.com/youtube/data/reference/rest/v3/videos) is polled after upload acceptance.                                                                                                                                                           |

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
retains its narrower 60-second ceiling. Instagram specifies 3–900-second Reels and
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
