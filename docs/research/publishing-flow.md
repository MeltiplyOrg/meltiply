# Publishing flow: source comparison and completion

Research date: 2026-10-28. Source review is not live-platform acceptance. No
third-party publishing credentials, platform audit, or real public post was used.

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
