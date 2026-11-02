# Frontend release verification

How to verify the frontend, and what each lane actually proves.
[The capability inventory](frontend-capabilities.md) remains the authority on what the
interface supports; this document does not claim unshipped features exist.

## Environment

GitHub Actions `ubuntu-24.04` runners with Node 24.18.0, Bun 1.4.2, and Playwright
1.64.0 Chromium as pinned by [`install-workspace`](../.github/actions/install-workspace/action.yml),
a disposable Docker PostgreSQL seeded from the repository seed, and the public Astro
project built and served as a static production preview on `127.0.0.1:4321`.

Acceptance lanes use the controlled-Provider Worker entries in `workers/*/test-support`,
which keep the production API, persistence, transport, and browser code; only external
Provider responses are controlled. These lanes do not certify live credentials,
platform audit, or real public posting.

## Browser coverage

| Acceptance area                                                     | Journey                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Authentication, setup closure, sign-out/sign-in, invitations        | `auth.spec.ts`, `invitation-journey.spec.ts`, `workspace-roles.spec.ts`, `device-consent.spec.ts` |
| Brand Profile create, edit, color, delete, narrow screens, keyboard | `shared-components.spec.ts`, `workspace-design.spec.ts`, `posts-composer.spec.ts`                 |
| Connection, reconnection, disconnect, OAuth failures, ownership     | `workspace-design.spec.ts`, provider connection smoke                                             |
| Posts Table, Calendar, Grid, details, deletion, filters             | `posts-publication.spec.ts`, `workspace-design.spec.ts`                                           |
| Composition, uploads, processing failures, provider choices         | `posts-composer.spec.ts`, `posts-publication.spec.ts`                                             |
| Scheduling, Now, weekly Queues, retry, cancellation                 | `posts-publication.spec.ts`, `publishing-queues.spec.ts`                                          |
| Appearance, language, account, security preferences                 | `shared-components.spec.ts`, `workspace-design.spec.ts`                                           |
| Landing and guide navigation, truthful samples, docs search, 404    | `public-site.spec.ts`                                                                             |
| Desktop, phone, keyboard, both palettes, reduced motion             | Screenshots and assertions across the journeys above                                              |

The public sample stays explicitly labeled (`Interactive demo · sample content`,
`Illustrative workflow`, `Demo account`, `Demo connection`), contains no form or input,
and every sample action targets the real app's sign-in route. Theme intent crosses the
landing/docs boundary through the shared preference owner. Native reduced motion is
proven by inspecting WAAPI creation synchronously during the tab selection rather than
waiting for an effect to finish.

The Lighthouse budgets run against the unauthenticated sign-in surface after `/posts`
follows its documented redirect. With a running API and production-like compression the
budgets are 0.70 performance, 0.90 accessibility, 0.90 best practices, and 0.90 SEO.

## Production reachability

- `bun run lint:dead` (Knip) reports no unused files, exports, or dependencies in the
  automatic `cloudflare-fast` job.
- `real-stack.spec.ts` proves retired paths (`/inbox`, `/billing`, `/agent`, `/plugs`,
  `/media`, and other removed route families) follow the unknown-route fallback
  instead of exposing a dormant screen.
- The production Worker entries remain `workers/api/src/index.ts` and
  `workers/automation/src/index.ts`. Controlled-Provider entries, fixture endpoints,
  preview handlers, and the media-processor test server are mounted only by
  test-support configurations or local launchers.

## Fixture rules

- Browser journeys create uniquely named Brand Profiles in the shared Workspace and
  restore that exact profile across reloads by name; a second browser context must
  receive the profile name explicitly. Never attach Channels to the first seeded
  profile.
- The suite clears sign-in buckets in the loopback test database between journeys,
  because more than ten owner sign-ins would otherwise hit the production per-email
  and per-address limits, and gives proxied auth requests a unique edge IP. Production
  limits stay enforced and integration-covered.
- The Analytics journey uses deterministic cohort values but unique Post and
  Distribution ids per run so retries cannot collide.
- Browser failures are reported without automatic retries; traces and screenshots are
  retained in the lane artifact before the next journey runs.
- Wrangler fires no cron triggers locally, so the acceptance API exposes a fixture-only
  route that invokes the Automation Worker's scheduled dispatcher through its existing
  service binding. Stored due times are unchanged and no future clock is injected.

## Known measurements

Runner subpixel rounding is real: the coarse-pointer theme track measures 47.29px
against a 47.5px assertion and item heights 43.35px against the CSS 44px minimum.
Assertions keep a 1px tolerance; the stylesheet contract is unchanged. Do not
re-litigate these as defects.

`frontend-full` starts a local API and serves the built client through a
compression-negotiating static preview, because Cloudflare compresses text assets at
the edge while Vite's preview serves them identity-encoded. Measure production-like
responses, not the identity-encoded artifact.

## Blockers

None. Performance work for authenticated publishing journeys is tracked by
[issue #3](https://github.com/MeltiplyOrg/meltiply/issues/3); existing budgets pass on
the measured production path.
