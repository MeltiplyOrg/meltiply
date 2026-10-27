# Frontend layout performance evidence

This report records the before-and-after measurements for the workspace layout,
responsiveness, and interaction-continuity work in issue #37. The change is
layout, CSS, and DOM-target work; it does not change data access, API calls,
caching, or state ownership. Results are lab measurements from a
production-equivalent build, not field interaction-to-next-paint (INP).

- Baseline revision: `master` at `b55476d` (the integration branch merge base).
- After revision measured: `unify-layout` at `4f9538e`. The final review follow-up
  reflows the palette to as few as one column and caps it to the dialog content
  box (not mounted on the measured Posts route), and replaces the coarse
  selection-row height utility with the same token-backed CSS value; it does not
  add data work, so these after numbers are retained as measured.
- Build: `APP_URL=http://127.0.0.1:3000 bun run --filter frontend-app build:production`,
  served by `vp preview` (the Cloudflare Vite/Workers local runtime) with the
  local API Worker and PostgreSQL seeded by `bun run db:seed`.
- Browser: managed headless Chromium, 1440×900 CSS viewport, device pixel ratio
  1.25, browser cache cleared before the direct entry, no CPU or network
  throttling.
- Data scenario: the seeded community workspace (Installation Owner), 60 loaded
  Posts, 10 Channels, and 3 Brand Profiles.
- Method: `PerformanceResourceTiming` for script and style transfer;
  `PerformanceObserver` for long tasks (over 50 ms), layout shifts, and event
  timing; `performance.now()` for action-to-DOM measurements. The same browser
  sequence ran against both revisions:
  1. cold direct `/posts`;
  2. Posts → Channels → Settings → Posts through the persistent navigation;
  3. open Create Post;
  4. type `zzzz` into the Posts search;
  5. clear the search and select the first Post;
  6. leave the loaded collection alone for twelve seconds to observe background
     refresh.

The local preview serves assets without content-encoding, so `transferSize` is
also the encoded and decoded size. Compare revisions rather than treating these
bytes as a CDN network budget. The direct-entry long-task total varied between
after runs; both raw runs are retained below.

## Results

| Scenario                                  | Baseline `b55476d`                           | After `4f9538e`                                                         | Observation                                                             |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Direct `/posts` script transfer           | 1,396 KB, 47 scripts                         | 1,397 KB, 47 scripts                                                    | Main chunk 789 KB; route chunks remain split; no unrelated route added. |
| Direct `/posts` style transfer            | 137 KB                                       | 138 KB                                                                  | Palette reflow rules add about 1 KB.                                    |
| Direct `/posts` long tasks                | 5 tasks, 458 ms total                        | 6 tasks, 492 ms idle; 669 ms after the full gate                        | Cause unresolved; route JS transfer is unchanged (see below).           |
| Direct `/posts` layout shift (CLS)        | 0.0001                                       | 0.0001                                                                  | The boot and route skeletons preserve height, columns, and scrollbars.  |
| Posts → Channels route script transfer    | 42 KB                                        | 43 KB                                                                   | Channels chunk and shared tabs/icons; no eager unrelated chunk.         |
| Posts → Channels long tasks               | 0                                            | 0 idle; 1 × 58 ms after the full gate                                   | Click event duration 32–48 ms across runs.                              |
| Channels → Settings route script transfer | 44 KB                                        | 45 KB                                                                   | Settings chunk grew 1 KB for the rail and palette owners.               |
| Channels → Settings long tasks            | 0                                            | 0                                                                       | Click event duration 24–40 ms.                                          |
| Settings → Posts route script transfer    | 0                                            | 0                                                                       | Both routes were already loaded.                                        |
| Settings → Posts long tasks               | 2 tasks, 150 ms                              | 1 task, 97 ms                                                           | Click event duration 24–40 ms.                                          |
| Composer open                             | 332 KB; 90 ms to dialog; 0 long tasks        | 332 KB; 107 ms idle / 132 ms post-check; 0 long tasks                   | `composer` and `time-of-day-field` stay on demand.                      |
| Filter typing (4 characters)              | Key event durations 24–32 ms; focus retained | Key event durations 16–32 ms idle / 32–48 ms post-check; focus retained | No full-page loading; loaded rows update in place.                      |
| Select first Post                         | Click event duration 40 ms; no long task     | Idle click event duration 40 ms; post-check 136 ms; no long task        | The bulk pill appears after the next paint; no duplicate submission.    |
| Background refresh after 12 s             | 60 rows, 0 skeletons                         | 60 rows, 0 skeletons                                                    | Usable content stays mounted during refresh.                            |

The first after run took place immediately after the full frontend gate while
the browser had more work in flight; a second after run on an otherwise idle
browser produced the lower long-task total. The baseline was also captured on
an idle browser. The cause of the direct-entry long-task difference is
unresolved: `/posts` gained a per-row `PostSelectionCheckbox` label wrapper,
rendered for fine and coarse pointers, plus small CSS changes. The route-level
JavaScript bytes are unchanged, and the Settings and palette modules are not
mounted on `/posts`, but these measurements do not isolate the row render-path
change from run-to-run browser work. No specific attribution is claimed without
further profiling.

## Conclusions

- The change adds no route dependency, eager chunk, or repeated data read.
  Composer and analytics chart chunks remain on demand; the Posts detail chunk
  (55 KB) remains a same-route readiness cost for immediate inspection, not an
  unrelated route download.
- Loading geometry is preserved before and after data resolution (CLS 0.0001),
  and background refresh keeps usable rows mounted.
- Idle-run filtering, selection, and composer open remain close to the baseline,
  but the post-check run measured higher key-event, selection, and composer
  durations. The evidence does not support a single same-range claim across both
  after runs; the variation is reported rather than attributed.
- No performance claim is made beyond these recorded lab measurements. They are
  not real-user INP.

## Raw results

- [Baseline](results/2026-10-27-frontend-layout/baseline.json)
- [After, idle browser](results/2026-10-27-frontend-layout/after-idle.json)
- [After, immediately following the full gate](results/2026-10-27-frontend-layout/after-post-check.json)

## Screenshots

- [Posts, 1440px, light](results/2026-10-27-frontend-layout/screenshots/posts-1440-light.webp)
- [Posts loading state, 1440px, light](results/2026-10-27-frontend-layout/screenshots/posts-loading-1440-light.webp)
- [Settings Security, 390px, dark; active section centered in the rail](results/2026-10-27-frontend-layout/screenshots/settings-security-390-dark.webp)
- [Brand Profile palette, 320px, light; reflowed four-column grid](results/2026-10-27-frontend-layout/screenshots/brand-profile-320-light.webp)
- [Composer, 390px, light](results/2026-10-27-frontend-layout/screenshots/composer-390-light.webp)
- [Channels directory, 390px, light](results/2026-10-27-frontend-layout/screenshots/channels-390-light.webp)
