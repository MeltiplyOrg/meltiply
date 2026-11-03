# Posts date-formatting cost

This report records the measured fix for the per-row `Intl.DateTimeFormat`
construction introduced while publishing timezones were added to the Posts
list. It is a browser micro-benchmark of the changed work, not an
end-to-end journey measurement; the journey budgets in
[`frontend/app/e2e/performance.spec.ts`](../../frontend/app/e2e/performance.spec.ts)
are too coarse to observe a change this small.

- Change: `postDateFormatters()` in
  [`frontend/app/src/lib/format.ts`](../../frontend/app/src/lib/format.ts)
  builds one formatter pair per publishing timezone. Table rows and Grid cards
  read that pair instead of constructing their own.
- Before: each rendered Post built two formatters (`month/day` and `hour/minute`);
  a 60-row page built 120 formatters on mount and again whenever the timezone
  preference changed.
- After: one pair per timezone, reused by every row and card; a timezone change
  builds one new pair.

## Method

- Runner: headless Chromium `156.0.8078.4` on Linux arm64, device pixel ratio 1,
  1440×900 viewport, no CPU or network throttling.
- Script: `page.evaluate` in a blank document, after a 20-pair warm-up.
- Sample: seven independent runs; the table reports the median.
- Measured operations:
  - **Construct 60 pairs** — sixty repetitions of the two `Intl.DateTimeFormat`
    constructors the removed code ran per row (120 constructions total).
  - **Format 60 rows** — sixty repetitions of `day.format()` plus
    `time.format()` through one cached pair (120 formatting calls total).

## Results

| Operation                               |  Median | Runs (ms)                                |
| --------------------------------------- | ------: | ---------------------------------------- |
| Construct 60 formatter pairs (before)   | 11.5 ms | 11.4, 12.6, 12.3, 11.4, 11.5, 11.5, 12.0 |
| Format 60 rows with cached pair (after) |  0.3 ms | 0.3, 0.4, 0.2, 0.3, 0.3, 0.2, 0.3        |

The before cost is main-thread work paid once per rendered page on mount (and
again on a preference change); the after cost is the unavoidable formatting.
The saving scales with appended pages and is independent of network time.

The `warmPosts` journey budget intentionally allows several seconds, so it does
not detect this regression on its own. The cache contract is pinned by
`postDateFormatters` tests in
[`frontend/app/src/lib/format.test.ts`](../../frontend/app/src/lib/format.test.ts),
which assert one instance per zone and no reuse across zones.
