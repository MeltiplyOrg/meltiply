# Consent surface duplication investigation

Research date: 2026-10-26. Scope: issue #18's report of a duplicate cookie-consent
pill on Meltiply's landing, documentation, and app surfaces. This records what was
exercised and observed; it does not assert a cause that was never reproduced.

## Method

Chromium 156 (Google Chrome for Testing) driven through Playwright, against the
Astro dev server and the production static build of `frontend/public`, plus the Vite
dev server of `frontend/app`. A `MutationObserver` sampled the counts of
`[data-cookie-controls]`, `[data-sileo-toast]`, `[data-sileo-pill]`, and
`[data-sileo-viewport]` on every DOM mutation and on a 40–120 ms interval, so a
single-frame duplicate would have been recorded rather than missed by end-state
assertions.

## Exercised scenarios

- First visit and hydration: landing (`/`), documentation (`/docs/`, `/docs/cookies`),
  the app, the 404 page, and an unknown docs slug. In the static build the consent
  markup is server-rendered and hydrated in place.
- Preference management, accept, reject, save, and confirmation exit, including the
  fade-out deadline.
- Documentation SPA navigation between guides, landing → docs, docs → landing, and
  three repeated docs ↔ docs round trips; the docs shell uses
  `transition:persist="meltiply-docs-shell"`.
- Theme changes while the prompt was open (four light/dark toggles).
- Viewports 1280×800, 1280×420, 390×844, 320×568, and 320×480, in both palettes.

## Result

The duplicate was not reproduced. Every sample held exactly one
`[data-cookie-controls]`, one `[data-sileo-toast]`, and one `[data-sileo-pill]` —
during the persist swap, hydration, management, confirmation, navigation, and theme
changes. The existing single-surface rendering is therefore left unchanged rather
than "fixed" speculatively. The only in-repo reference to painting two pills is
`Sileo`'s collapse-freeze note; the confirmation collapse exercised that path without
producing a second pill element at any sampled width.

One React hydration attribute-mismatch warning appeared during a multi-page scenario
run. It was not reproduced in the hydration-focused runs, no second consent surface
accompanied it, and it is not attributed to the consent island here.

## Related change

The investigation did confirm a truthfulness defect the issue also names: the prompt
offered **Analytics** and **Marketing** toggles even though no code read those
categories and no such tracker is installed. The consent record and prompt now expose
only the implemented functional purpose, and the cookie documentation matches.
