# Meltiply product application

React/Vite SPA with React Router, served by a Cloudflare Worker. It consumes
[@meltiply/contracts](../../packages/contracts/README.md) for the API and
`@meltiply/ui` in `frontend/shared/` for shared design and motion. The landing
page and public docs are separate Astro workspaces.

App and docs sidebar hover selectors share their borderless, shadow-free paint in
[`frontend/shared/motion.css`](../shared/motion.css). Keep selector styling there
rather than adding per-page overrides.

The sidebar header and browser tab reuse the shared Meltiply mark and favicon.
The active Workspace identity is noninteractive; workspace switching is unavailable.
Account pictures use the authenticated user's avatar URL, with a user-icon fallback
for missing or failed images; no email-based avatar lookup is performed.

Meltiply has two dialog types. Use `CenterDialog` (`@meltiply/ui/center-dialog`)
for compact centered modals and `CenterAlertDialog` for confirmations. Use
[`SideDialog`](../shared/src/components/ui/side-dialog.tsx) from
`@meltiply/ui/side-dialog` for right-edge
inspection panels. Its controlled `open`/`onOpenChange`, required `title`, optional
`description`/`footer`, and body children share scrolling, focus restoration, and
low-motion behavior; Post details is the first consumer.

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
API credential. The API resolves `x-workspace-id` through workspace membership,
or selects the personal workspace when the header is absent.

The [cookie policy](https://meltiply.com/docs/cookies) governs optional
functional preferences and browser-local draft/upload recovery. Until functional
consent is accepted, these convenience values are neither read nor persisted;
authentication and server-backed Posts and uploads remain available. Declining
consent must not block composer initialization. Switching Brand Profile or Post
abandons the previous composition and cancels its in-flight uploads. A theme
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
