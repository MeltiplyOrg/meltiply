# Frontend runtime

The frontend is a React single-page application built with Vite and served by a Cloudflare Worker. Use React Router for navigation, Wrangler for Worker configuration and deployment, and the Cloudflare Vite plugin for local runtime parity. Use the `effectv4` skill when writing or editing Effect programs, services, layers, or query/mutation hooks in `src/lib/effect`, `src/lib/queries.ts`, `src/lib/api.ts`, or `src/lib/upload.ts`.

## Design system guardrails

`bun run lint` enforces the product design contract through `@shadcn/lint`.
Run it after every UI change and fix every diagnostic; do not add a
suppression or a linter exception without an explicit design decision.

- Use only tokens declared in `frontend/shared/tokens.css` (imported by
  `src/app/globals.css`). Provider-brand tokens are
  reserved for `PlatformIcon`; product state uses the semantic accent, green,
  orange, and red tokens.
- Do not introduce arbitrary Tailwind values. The narrow existing exception
  list preserves the shipped visual scale; promote a reviewed, reusable value
  to a token before using a new one.
- Do not add inline styles outside the documented dynamic geometry and motion
  seams. Use a CSS custom property plus a token-aware utility when a runtime
  value is necessary.
- Treat `src/components/ui`, `atoms`, and `primitives` as the design-system
  boundary. Reuse their variants and composition patterns; add a reviewed
  variant or primitive instead of route-specific visual restyling.

## UI consistency gates

- Compose product controls from `src/components/ui`, `atoms`, and `primitives`.
  Feature code may not render native button, input, select, or textarea elements.
- Use `lucide-react` for product icons and the canonical `PlatformIcon` for
  provider brand artwork.
- Match color to its role: `page`/`surface`/`inset` for structure,
  `ink`/`line` for hierarchy, `accent` for deliberate product emphasis, and
  `green`/`orange`/`red` only for success, caution, and failure. Provider color
  tokens belong exclusively to `PlatformIcon`; raw palette utilities are rejected.
- `bun run design:check` scans every frontend source file for visual anti-patterns.
  The shared edit hook runs the same detector after each UI edit; fix a finding,
  never suppress it without an explicit product decision.
- Before completing UI work, run the focused browser path at desktop and 390px,
  then inspect light and dark modes for hierarchy, overflow, focus, and relevant
  loading, empty, error, disabled, and selected states. Update or add a
  Playwright screenshot baseline for every stable changed surface, then run
  `bun run test:visual`.
