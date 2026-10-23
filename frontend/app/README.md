# Meltiply product application

React/Vite SPA with React Router, served by a Cloudflare Worker. It consumes
[@meltiply/contracts](../../packages/contracts/README.md) for API contracts and
`@meltiply/ui` in `frontend/shared/` for the canonical controls, palette, fonts,
icons, dialogs, feedback, and animation recipes. The public site/docs use Astro.

## UI implementation

Read [shared UI ownership](../../docs/frontend-ui.md),
[layout/scroll boundaries](../../docs/frontend-layout.md), and the
[capability inventory](../../docs/frontend-capabilities.md) before changing a surface.
They describe the current Gr8r-adapted design, not a second theme or migration plan.

Posts orders Table, Calendar, Grid in its toolbar; Channels uses the Accounts/
Brand Profiles directory; Settings exposes Appearance, Language, Account, and
inline Security. The shell keeps Posts and Channels as single destinations and
puts jump search in the top bar. Workspace identity is read-only.

Features own authorized data, selection, labels, and mutations. Shared
`CenterDialog`, `CenterAlertDialog`, and `SideDialog` own their frames, scrolling,
focus, dismissal, and transitions. `usePostDetailSurface` supplies real properties,
caption, attachments, and Channel outcomes to the edge/phone inspector.

There is one animation path, without a motion-mode provider, stored preference,
root flag, mode props, or alternate branches. Preserve implemented animations
during cleanup; extend their canonical owners for new animation work.
Native OS reduced-motion preferences still suppress spatial WAAPI effects.

The data router supports Security departure guards across sections, routes, and
history while a request or enrollment is pending. Posts keeps an interrupted
composer mounted during inspection, and loads its editing dependencies only when
composition starts; URL-backed composition intent stays synchronized on navigation.

Self-hosted font assets have explicit exports in `frontend/shared/package.json`.
The Vite reload hook watches that manifest as well as the root environment file,
so export-map changes invalidate cached package resolution in development.

The interactive cookie notice loads behind its own Suspense boundary, keeping
toast animation dependencies off the authentication/workspace first-paint path.
The inline consent bootstrap remains authoritative before it loads: optional
purposes stay denied without a saved decision, including when loading fails.

## Local development

From the repository root:

```bash
make setup
make dev
```

Use the app URL printed by the launcher; a published tunnel becomes the canonical
origin. `/api/*` is proxied to the API Worker. All local services read the root
`.env`; see [the root quickstart](../../README.md#get-started) for setup,
fixture logins, and public-tunnel controls.

For app-only iteration against an existing backend, run `make frontend-boot`.
For a built Worker preview, run `make frontend-build` followed by
`make frontend-preview`.

### Authentication and configuration

Better Auth keeps the HttpOnly session cookie on `/api/auth`. The app exchanges
it for an in-memory bearer JWT used on `/api/v1`; the session cookie is not an
API credential. Each protected request also checks that the JWT's session is
live and belongs to the installation owner. The API resolves `x-workspace-id`
through workspace membership, or selects the personal workspace when absent.

`/sign-in` owns first-run setup, owner sign-in, email verification recovery,
password reset, and optional authenticator challenges. Setup requires the
API-only `AUTH_SETUP_SECRET` and closes permanently when the single owner exists.
There is no separate public registration route. **Settings → Security** on desktop
and mobile provides password changes and complete authenticator enrollment,
backup-code replacement, and disabling with password reauthentication.

The [cookie policy](https://meltiply.com/docs/cookies) governs optional
functional preferences and browser-local draft/upload recovery. Until functional
consent is accepted, these convenience values are neither read nor persisted;
authentication and server-backed Posts and uploads remain available. Declining
consent must not block composer initialization. Switching the collection's Brand
Profile filter leaves an open composition untouched; opening a different Post —
or a composition whose owner changes — abandons the previous composition and
cancels its in-flight uploads. A theme
selected on the landing page or docs follows links into the app without granting
storage consent. The app loads palette CSS before first paint and preserves
transferred intent through hydration and an initial cookie rejection. Actual
consent withdrawal returns to the device palette.
See the cookie policy for persistence rules.

`API_BASE_URL` must be an origin without a path, query, or fragment. Backend
secrets belong only in protected Worker configuration, never browser variables.
Local mail is simulated in development output; signup success does not prove
email delivery. Deployed sign-in requires verified email.

## Verification

Run the app completion gate from the repository root:

```bash
bun run --filter frontend-app check
```

The workspace [package.json](package.json) defines focused checks, formatting,
binding generation, builds, and deployment scripts. Use it instead of maintaining
a second command inventory here.

### Browser journeys

```bash
make frontend-e2e-install
make frontend-test-e2e
```

The default Playwright run uses a production frontend build with the real local
API and PostgreSQL. Keep Playwright and its browser image/cache revisions aligned;
reinstall the browser after upgrading Playwright.

Local journeys sign in as the seeded owner rather than registering more users.
The isolated-workspace helper resets that owner's domain fixtures only on the
guarded loopback test database; never point it at shared or production data.
Set `MELTIPLY_DATABASE_TEST_ADMIN_URL` explicitly to that disposable database's
admin connection URL before running local journeys; there is no reset fallback.
The [production-image owner journey](e2e/selfhost-auth-smoke.mjs) instead exercises
an empty installation, real SMTP capture, verification, recovery, and 2FA.
Workspace sign-out steps open **Account menu → Sign out**; the separate button in
Settings → Account is not a persistent sidebar footer control. Both browser
journeys must follow the canonical menu entry when leaving the Posts surface.

Publication and channel-scoped composer journeys require the controlled-Provider
acceptance backend and are excluded from the default run:

```bash
MELTIPLY_E2E_ACCEPTANCE=1 make frontend-test-e2e
```

Acceptance entries expose fixture routes that production entries do not.
`MELTIPLY_E2E_PUBLICATION=1` selects the same mode. Set
`MELTIPLY_E2E_REUSE_SERVERS=1` only when the corresponding backend and production
frontend preview already run; a development server is not equivalent.
See [playwright.config.ts](playwright.config.ts) for project selection and server
startup, and [e2e/](e2e/) for journey requirements.

For a deployed staging smoke, provide both an origin and an externally created
Playwright storage-state file containing its Better Auth session cookie:

```bash
STAGING_E2E_BASE_URL=https://frontend.staging.meltiply.com \
STAGING_E2E_STORAGE_STATE=./.secrets/better-auth-staging-storage.json \
make frontend-test-e2e
```

The smoke verifies the Posts and Channels route controls and exercises Channels
search/reset without creating business data. Page-heading copy is not a readiness
contract.

Keep session state outside version control. Optional metrics delivery requires
an explicit `MELTIPLY_E2E_PUSHGATEWAY_URL`; without it, nothing is pushed.

## Deployment

[wrangler.jsonc](wrangler.jsonc) owns the application's Cloudflare configuration.
Use the workspace's explicit staging/production upload and deploy scripts: they
select the same `CLOUDFLARE_ENV` for Vite and Wrangler, keeping the built bundle
and deployment environment aligned. Set the target's `API_BASE_URL` at build time.
