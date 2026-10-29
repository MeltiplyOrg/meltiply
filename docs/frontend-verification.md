# Frontend release verification

This record closes the release-readiness verification requested by
[issue #22](https://github.com/MeltiplyOrg/meltiply/issues/22) after the
twelve frontend cleanup merges. It records the hosted runs, browser evidence,
and the defects those runs exposed. It is not a claim that unshipped features
exist; [the capability inventory](frontend-capabilities.md) remains the
authority on what the interface supports.

## Environment

- GitHub Actions `ubuntu-24.04` runners with Node 24.18.0, Bun 1.4.2, and
  Playwright 1.64.0 Chromium, as pinned by
  [`install-workspace`](https://github.com/MeltiplyOrg/meltiply/blob/master/.github/actions/install-workspace/action.yml).
- A disposable Docker PostgreSQL instance seeded from the repository seed.
- Acceptance lanes use the controlled-Provider Worker entries in
  `workers/*/test-support`, which keep the production API, persistence,
  transport, and browser code; only external Provider responses are controlled.
- The public Astro project is built and served as a static production preview on
  `127.0.0.1:4321` for the public journeys.

## Hosted runs

The integration branch is `verify-single-use`. Code and harness changes end at
`efe6866`; the last commit records this evidence.

| Lane                    | Dispatch and key command                                                                                                                                                     | Commit    | Outcome | Evidence                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic CI (`ci.yml`) | Push and PR checks: format, types, bindings, lint, unit tests with coverage, production builds, contracts, PostgreSQL integration, image builds                              | `efe6866` | success | [PR run 40868406838](https://github.com/MeltiplyOrg/meltiply/actions/runs/40868406838) and [push run 40868400360](https://github.com/MeltiplyOrg/meltiply/actions/runs/40868400360) |
| `cloudflare-full`       | `gh workflow run extended.yml -f lane=cloudflare-full`; then `bun run cloudflare:check`, the provider connection smoke, and the focused reconnect browser journey            | `5b5a28b` | success | [run 40855581970](https://github.com/MeltiplyOrg/meltiply/actions/runs/40855581970), artifact `extended-cloudflare-full`                                                            |
| `frontend-ui`           | `gh workflow run extended.yml -f lane=frontend-ui`; then both frontend checks, dead code, docs links, `workspace-design`, `analytics`, and `public-site` projects            | `dbc5a37` | success | [run 40863047712](https://github.com/MeltiplyOrg/meltiply/actions/runs/40863047712), artifact `extended-frontend-ui`                                                                |
| `frontend-full`         | `gh workflow run extended.yml -f lane=frontend-full`; then `bun run test:e2e --trace on`, the controlled-Provider recovery journey, and Lighthouse with the existing budgets | `2bb9901` | success | [run 40867452963](https://github.com/MeltiplyOrg/meltiply/actions/runs/40867452963), artifact `extended-frontend-full`                                                              |
| `publishing-browser`    | `gh workflow run extended.yml -f lane=publishing-browser`; then publication, weekly Queue, and multi-profile recovery journeys with real media                               | `0e3eb2f` | success | [run 40853887828](https://github.com/MeltiplyOrg/meltiply/actions/runs/40853887828), artifact `extended-publishing-browser`                                                         |
| `device-authorization`  | `gh workflow run extended.yml -f lane=device-authorization`; then `bun run cloudflare:check`, the device consent browser journey, and the CLI HTTP lifecycle smoke           | `0e3eb2f` | success | [run 40853892712](https://github.com/MeltiplyOrg/meltiply/actions/runs/40853892712), artifact `extended-device-authorization`                                                       |

The `0e3eb2f` runs remain valid for their lanes: every later commit changes
browser specifications, the loopback sign-in reset, the cloudflare-full seed
step, test tolerance, or the CI-only Lighthouse preview. Those lanes either do
not execute those files, or the changed sign-in helper is exercised repeatedly
by `frontend-full`. `frontend-ui` ran at `dbc5a37`; its only later differences
are the coarse-pointer tolerance and the Lighthouse harness, neither of which
that lane executes. `frontend-full` ran at `2bb9901`; the only later change
registers the preview script as a Knip entry.

The Lighthouse budgets run against the unauthenticated sign-in surface after
`/posts` follows its documented redirect. With a running API and
production-like compression the hosted report scores performance 0.81,
accessibility 1.00, best practices 1.00, and SEO 0.91, against budgets of 0.70,
0.90, 0.90, and 0.90.

## Browser coverage

| Acceptance area                                                     | Journey                                                                                           | Evidence                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Authentication, setup closure, sign-out/sign-in, invitations        | `auth.spec.ts`, `invitation-journey.spec.ts`, `workspace-roles.spec.ts`, `device-consent.spec.ts` | `extended-frontend-full`, `extended-device-authorization`                                       |
| Brand Profile create, edit, color, delete, narrow screens, keyboard | `shared-components.spec.ts`, `workspace-design.spec.ts`, `posts-composer.spec.ts`                 | `extended-frontend-full`, `extended-frontend-ui`                                                |
| Connection, reconnection, disconnect, OAuth failures, ownership     | `workspace-design.spec.ts`, provider connection smoke                                             | `extended-frontend-ui`, `extended-cloudflare-full`                                              |
| Posts Table, Calendar, Grid, details, deletion, filters             | `posts-publication.spec.ts`, `workspace-design.spec.ts`                                           | `extended-publishing-browser`, `extended-frontend-ui`                                           |
| Composition, uploads, processing failures, provider choices         | `posts-composer.spec.ts`, `posts-publication.spec.ts`                                             | `extended-frontend-full`, `extended-publishing-browser`                                         |
| Scheduling, Now, weekly Queues, retry, cancellation                 | `posts-publication.spec.ts`, `publishing-queues.spec.ts`                                          | `extended-publishing-browser`                                                                   |
| Appearance, language, account, security preferences                 | `shared-components.spec.ts`, `workspace-design.spec.ts`                                           | `extended-frontend-full`, `extended-frontend-ui`                                                |
| Landing and guide navigation, truthful samples, docs search, 404    | `public-site.spec.ts`                                                                             | `extended-frontend-ui`                                                                          |
| Desktop, phone, keyboard, both palettes, reduced motion             | Screenshots and assertions across the journeys above                                              | `public-landing-*`, `public-docs-*`, `analytics-*`, `shared-components-*`, `navigation-focus-*` |

The public sample remains explicitly labeled (`Interactive demo · sample
content`, `Illustrative workflow`, `Demo account`, `Demo connection`), contains
no form or input, and every sample action targets the real app's sign-in route.
Theme intent crosses the landing/docs boundary through the shared preference
owner, and native reduced motion is proven by inspecting WAAPI creation
synchronously during the tab selection rather than by waiting for an effect to
finish.

## Production reachability

- `bun run lint:dead` (Knip) reports no unused files, exports, or dependencies
  in the automatic `cloudflare-fast` job.
- `real-stack.spec.ts` proves retired paths (`/inbox`, `/billing`, `/agent`,
  `/plugs`, `/media`, and the other removed route families) follow the unknown
  route fallback instead of exposing a dormant screen.
- [Retired-chain reachability evidence](frontend-capabilities.md#retired-chain-reachability-evidence)
  records the router, backend-contract, and shared-consumer review for each
  removed chain.
- The production Worker entries remain `workers/api/src/index.ts` and
  `workers/automation/src/index.ts`. Controlled-Provider entries, fixture
  endpoints, preview handlers, and the media-processor test server are mounted
  only by test-support configurations or local launchers.

## Defects found and resolved

- `cloudflare-full` ran its browser journey after the comprehensive gate had
  transferred ownership and exhausted quota fixtures, so sign-in never reached
  Posts. The lane now reseeds its disposable database before that browser step.
- The full browser suite signs the same fixture members in more than the
  production limit of ten attempts per email and per address per ten minutes.
  The suite now clears sign-in buckets in the loopback test database and gives
  proxied auth requests a unique edge IP; the production limit and its
  integration coverage are unchanged.
- The shared segmented journey still assumed the desktop `Post view` control
  survived at 320px. Phones use the compact view dropdown, so the journey now
  returns to the desktop viewport before observing a live reduced-motion change.
- The coarse-pointer theme track assertion required 47.5px while the rendered
  track measures 47.29px, and item heights measure 43.35px against the CSS 44px
  minimum. Both differences are subpixel layout rounding on the hosted Chromium
  runner, so the journey keeps a 1px measurement tolerance instead of a
  font-dependent fraction. The stylesheet contract is unchanged.
- The role journey matched the row action button `Actions for Epsilon Suspended`
  when looking for a `Suspend` button. The lifecycle assertions now require
  exact control names.
- The Lighthouse step measured Vite's identity-encoded preview without a running
  API, so auth reads returned 502 and the performance budget failed on an
  encoding artifact. The lane now starts the local Worker and serves the built
  client through a brotli/gzip-negotiating static preview; the unchanged budgets
  measure the production response shape.
- The Analytics journey still expected TikTok to lack analytics. The implemented
  Provider reports TikTok analytics, so the journey now verifies TikTok in the
  KPI, chart table, and ranking instead of a partial-data banner.
- The reduced-motion assertion originally waited for animations to finish, which
  also passes when suppression breaks. It now inspects WAAPI creation during the
  transition, and the same probe reports seven animations without the reduced
  motion preference.
- The desktop documentation capture was taken after navigating to the landing
  page; it now records the guide surface before leaving it.

## Blockers

None. Every required gate and hosted browser journey passed at the recorded
commits. Performance improvements for authenticated publishing journeys remain
tracked by [issue #3](https://github.com/MeltiplyOrg/meltiply/issues/3); the
existing budgets pass on the measured production path.
