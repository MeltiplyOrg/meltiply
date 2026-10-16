# Vite+ research

Primary-source findings on Vite+, VoidZero's unified web toolchain: product
surface, current release and license, migration behavior and limits,
runtime/package-manager handling, monorepo task caching, Cloudflare
compatibility evidence, and CI integration. Captured 2026-10-12 from the cited
pages and repository metadata.

All speed numbers below are **vendor claims** from VoidZero/Oxc pages and
release notes — no independent benchmarks were found or run. Statements marked
"unverified" are plausible but not established by a cited source.

The repository-fit assessment below records the **pre-migration baseline**.
Current dependencies and commands are authoritative in the
[root package catalog](../../package.json) and
[unified configuration](../../vite.config.ts).

## Product

Vite+ is a single CLI (`vp`) plus a project-local npm package (`vite-plus`)
that bundles Vite 8 (on Rolldown), Vitest, Oxlint, Oxfmt, tsdown, a monorepo
task runner ("Vite Task"), and Node.js/package-manager version management into
one configured stack. It is explicitly "not a replacement for Vite" — it wraps
the existing tools behind one `vite.config.ts` and a fixed command surface
(<https://voidzero.dev/posts/announcing-vite-plus-1-0>, published 2026-09-28;
<https://viteplus.dev/guide>).

A single `vite-plus` dev dependency is meant to replace a cluster of direct
dependencies (`vite`, `vitest`, `eslint`, `prettier`, `tsup`, `turbo`, …).
`vite` imports in dependencies resolve through an `npm:` alias to
`@voidzero-dev/vite-plus-core`; `vitest` re-exports as `vite-plus/test*`
(<https://viteplus.dev/guide/local-cli>, /guide/migrate-rules).

### Command surface (1.x)

| Area             | Commands                                                                                           | Powered by                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Scaffold/migrate | `vp create`, `vp migrate`                                                                          | Vite+ templates + migration rules             |
| Package manager  | `vp install`, `add`, `remove`, `update`, `dedupe`, `outdated`, `list`, `why`, `info`, `link`, `pm` | The project's own PM (npm/pnpm/Yarn/Bun)      |
| Dev/build        | `vp dev`, `vp build`, `vp preview`                                                                 | Vite 8 + Rolldown                             |
| Checks           | `vp check` (all three), `vp lint`, `vp fmt`                                                        | Oxlint, Oxfmt, tsgolint (TS 7/"Go" toolchain) |
| Test             | `vp test`                                                                                          | Vitest (bundled `5.0.3` in 1.1.0)             |
| Library builds   | `vp pack`                                                                                          | tsdown (0.23 in 1.0)                          |
| Tasks            | `vp run` / `vpr`, `vp cache clean`                                                                 | Vite Task                                     |
| Environment      | `vp env`, `vp node`, `vp upgrade`, `vp implode`                                                    | Global CLI only                               |
| Misc             | `vp toolchain`, `vp exec`, `vp dlx`/`vpx`, `vp config`, `vp hooks`, `vp staged`                    | Vite+                                         |

Built-in command names cannot be shadowed by `package.json` scripts: `vp dev`
is always the Vite dev server; a `dev` script runs only via `vp run dev`
(<https://viteplus.dev/guide/run>). `vp check` is only format + lint +
type-check — it is not a general CI gate (no dead-code, secrets, or
spell-check equivalents; there is no Vite+ analogue to Knip).

## Maturity, version, license

- Announced 2025-10-13 at ViteConf as a planned **commercial** product; the
  paid model was dropped before public release, and the alpha post re-licensed
  it MIT (<https://voidzero.dev/posts/announcing-vite-plus>, which now carries
  an "Update" preamble retracting the licensing section;
  <https://voidzero.dev/posts/announcing-vite-plus-alpha>, 2026-03-13).
- Release line: Alpha 2026-03-13 → Beta 2026-07-02 → **1.0 2026-09-28** →
  latest **v1.1.0 2026-10-07** ("faster `vp dev` startup"), per GitHub releases
  and the npm `latest` dist-tag (registry: `vite-plus@1.1.0`, `"license": "MIT"`).
  The homepage's "Vite+ 1.0 is here … Free and open source under the MIT
  license" is accurate for the 1.x line; the current release is 1.1.0.
- License verified three ways: repo `LICENSE` (MIT, GitHub API `licenseInfo`),
  npm package metadata, and the 1.0 post. On 2026-06-04 VoidZero announced it
  is joining Cloudflare, stating Vite, Vitest, Rolldown, Oxc **and Vite+**
  "will remain open-source and MIT-licensed"
  (<https://voidzero.dev/posts/voidzero-cloudflare>).
- Self-described as "1.0 but … far from feature-complete"; remote caching,
  `vp release`, `vp docs`, deeper monorepo diagnostics are explicitly future
  work (1.0 post, "What's next").
- Vendor-claimed traction: "closing in on two million weekly downloads", >2,600
  dependent public repos (1.0 post). ~6k GitHub stars on `voidzero-dev/vite-plus`.

Vendor performance claims (label as such if repeated):

- "up to 40× faster builds than webpack"; Oxlint "~50× to ~100× faster than
  ESLint" (oxc-project/bench-linter); Oxfmt "up to 30× faster than Prettier"
  and "2× faster than Biome" (oxc-project/bench-formatter); v1.1.0 makes
  `vp dev` start "~24% sooner … ~30% less memory in the parent process";
  Oxc-native React Compiler "10× faster than the Babel plugin".

## CLI distribution and runtime/package-manager behavior

- **Global `vp`**: standalone Rust binary, no pre-existing Node required
  (`curl -fsSL https://vite.plus | bash`; `irm https://vite.plus/ps1 | iex`;
  `vp-setup.exe` — currently unsigned, SmartScreen warning; Homebrew;
  `ghcr.io/voidzero-dev/vite-plus` image). Platform list is Node v24 tier-1/2:
  Linux glibc x64/arm64, musl x64 (experimental)/arm64, Windows x64/arm64,
  macOS x64/arm64; Alpine needs `libstdc++` for the managed unofficial Node
  builds (<https://viteplus.dev/guide>, /guide/global-cli).
- **Local CLI**: `vite-plus` npm package (dev dependency) containing the same
  `vp` binary plus the toolchain; needs an existing Node + PM. Global `vp`
  **delegates** `dev`/`build`/`test`/`run` to the project's installed
  `vite-plus` when present, so the pinned project version wins
  (/guide/global-cli#use-both-clis-together).
- **`vp env` manages Node.js only as the runtime.** npm, pnpm, Yarn, and Bun
  are peer _package-manager_ families; there is no Bun/Deno runtime management.
  A Bun project still executes scripts/tests on the resolved Node.js
  (/guide/env: "Node.js is the runtime used to execute JavaScript tools and
  scripts … Each project can select npm, pnpm, Yarn, or Bun").
- Managed mode (default after opt-in) installs `node`, `npm`, `pnpm`, `yarn`,
  `bun` shims that resolve per project. Node selection order: `.node-version`
  → `devEngines.runtime` → `engines.node` → `.nvmrc`, else global default/LTS.
  PM selection: `VP_PACKAGE_MANAGER` → `packageManager` field →
  `devEngines.packageManager` → lockfile/config → defaults. `vp env off` reverts
  to system tools; modes are per-family (`vp env off pm`, `vp env on bun`).
- Vite+ 1.x toolchain requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`
  (/guide/vitest-v5, /guide/migrate); migration rewrites incompatible pins to
  the nearest supported minimum.

## Migration (`vp migrate`) — scope and limitations

Workspace-root only: "Vite+ cannot migrate one workspace member, because
migration updates the package-manager configuration, the catalogs, and the
lockfiles that all members share" (/guide/migrate). Prerequisites: Vite ≥8 and
Vitest ≥4.1 already installed; keep the original lockfile so the migrator can
identify the source versions. "Most projects will require further manual
adjustments." Migration is stated to be idempotent.

What it does (/guide/migrate, /guide/migrate-rules):

- Adds `vite-plus`, points `vite` at the `npm:@voidzero-dev/vite-plus-core`
  alias, removes direct `vitest`/`@vitest/*` where the bundled copy suffices
  (keeps a package-local `vitest` at the exact bundled version when a real peer
  needs it), rewrites package scripts (`vite`→`vp dev` etc.; `bunx --bun` is
  preserved), merges tool config into `vite.config.ts`, converts `.nvmrc`/Volta
  to `.node-version`, and runs `vp fmt` on touched files (skipped while the
  project still uses Prettier).
- `vitest*`/`@vitest/browser*` imports → `vite-plus/test*`; `declare module
  'vitest'`/`'@vitest/browser*'` are deliberately **not** rewritten (module
  augmentation must keep upstream identity). `vite` imports are rewritten only
  inside config entry files; `vite-plus` "owns only `defineConfig`,
  `defineProject`, and `lazyPlugins`" — other Vite API imports keep the `vite`
  specifier and resolve via the core alias.
- ESLint and Prettier migration are "optional" steps in the script-rewrite
  table (`eslint`→`vp lint`, `prettier`→`vp fmt` "when its optional migration
  runs"). Husky/lefthook/simple-git-hooks/yorkie are **not** converted (left in
  place with a warning); lint-staged migrates only its supported config shape.
- Rolldown-incompatible Vite config (e.g. `manualChunks`) is reported as a
  warning, not changed.
- Vitest 4→5 is the big semantic upgrade bundled into Vite+ 1.0: the migrator
  injects `// Vitest v4 compatibility` settings (clearMocks, sharedViteServer,
  inline extends, locator exactness, glob coverage thresholds, Temporal fake
  timers) plus a long manual review checklist, and rewrites affected source
  patterns (`test.sequential`, browser matchers, `bench` → fixture API).
  Projects below Vitest 4 must upgrade to v4 first (/guide/vitest-v5).

### ESLint custom rules/plugins

- Oxlint implements ~800+ ESLint-compatible rules natively
  (<https://oxc.rs/docs/guide/usage/linter>); unsupported-but-needed plugins run
  as **JS plugins**, which are **alpha** with explicit gaps: no custom file
  formats/parsers (Vue SFC blocks beyond support, Svelte, Angular — and by
  extension `.astro`), and **no type-aware rules inside JS plugins**
  (<https://oxc.rs/docs/guide/usage/linter/js-plugins>).
- **Local custom ESLint plugins are not auto-migrated** — `@oxlint/migrate`
  "will not [migrate them] automatically … right now"; they must be added to
  `jsPlugins` by hand (<https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint>).
- Confirmed migration bug: `vp migrate` **silently drops custom lint rules**
  when a local `jsPlugin`'s namespace can't be derived from the file path —
  all `namespace/*` rules are removed from merged config without warning
  (open issue <https://github.com/voidzero-dev/vite-plus/issues/2231>). Any
  inline/custom-rule flat-config setup needs a rule-by-rule diff after migration.
- Plugins written for Oxlint import from `vite-plus/lint/plugins` (and
  `…/lint/plugins-dev` for `RuleTester`); migration repoints `oxlint`/
  `@oxlint/plugins` imports there (/guide/migrate-rules#oxlint-js-plugin-imports).
- `vp migrate` does not promise ESLint-config parity even where it converts:
  unsupported rules are dropped; running ESLint alongside Oxlint during
  transition is the documented pattern (oxc.rs migrate-from-eslint,
  `eslint-plugin-oxlint` to dedupe rules).

### Formatter and TypeScript behavior

- Oxfmt claims Prettier-compatible output (treats diffs as bugs) and replaces
  common plugins with built-ins (`sortImports`, `sortTailwindcss`,
  `sortPackageJson`, `jsdoc`). Hard limits: **Prettier plugins unsupported**,
  `prettier` field in `package.json` ignored, nested `.editorconfig` ignored,
  `experimentalTernaries` absent, and **`printWidth` defaults to 100** vs
  Prettier's 80 (<https://oxc.rs/docs/guide/usage/formatter/unsupported-features>).
- File coverage: native Rust formatting for JS/TS/JSON/CSS/GraphQL/TOML/YAML/MD;
  HTML/Vue/Svelte/MDX/Handlebars/MJML delegated to a bundled Prettier. **Astro
  (`.astro`) is on neither list** — `.astro` files are not formatted (and Oxlint
  cannot lint them, per the no-custom-parsers gap). Prettier-backed formats need
  Node and the npm-package install path
  (<https://oxc.rs/docs/guide/usage/formatter/language-support>).
- Type checking in `vp check`/`vp lint` is **not `tsc`**: it runs tsgolint on
  the TypeScript 7 (native/"Go") toolchain, gated behind
  `lint.options.typeAware` + `typeCheck` (enabled by `vp create`/`vp migrate`).
  **`compilerOptions.baseUrl` is unsupported** — the type-aware path is skipped
  entirely if the `ts5to6 --fixBaseUrl` fix fails or is declined
  (/guide/check, /guide/troubleshooting). Diagnostic parity with a specific
  `tsc` version is unverified — it is a different compiler implementation.
- Workspace semantics: `vp check` uses only the root `lint`/`fmt` blocks;
  package-level configs cannot override them for `check`. Nested configs "do
  not apply to individual files" — overrides must live in the root
  `vite.config.ts` (`lint.overrides`, `fmt.overrides`) (/guide/monorepo,
  /guide/troubleshooting).

## Monorepo task caching — caveats

Vite Task (`vp run`/`vpr`) does dependency-ordered, filtered, cached task runs:

- **Local disk cache only**: `node_modules/.vite/task-cache` at the workspace
  root. **No remote/shared cache** — listed as planned future work in the 1.0
  post. Sharing across CI is an _experimental_ `actions/cache` wrapper
  (GitHub-only doc, /guide/github-actions-cache). There is **no per-entry
  eviction**: "the task cache can keep growing"; management is pushed to the CI
  cache layer.
- **Correctness model**: fingerprint = CLI args + fingerprinted env vars +
  tracked file inputs (reads, missing-file probes, directory listings) learned
  by watching execution; outputs are whatever the process wrote. Only
  successful (exit 0) runs are cached.
- **Stale-cache risk is real by design**: env reads are _not_ tracked. Tasks
  run in a scrubbed environment — only a small passthrough set (`PATH`, `HOME`,
  `CI`, …) reaches them; anything else must be declared via `cache.env`
  (fingerprinted) or `cache.untrackedEnv` (passed but not fingerprinted). A task
  that needs an undeclared env var sees a _different_ environment under
  `vp run` than under a plain `pnpm run` — silent behavior change, not just
  caching semantics. Cooperative tracking that closes this gap exists for
  **`vp build` only** (`VITE_*`, `NODE_ENV`, tool temp dirs reported
  automatically); every other command — including repo scripts and third-party
  tools — relies on FS tracking plus manual config
  (/guide/automatic-data-tracking).
- Defaults: `vite.config.ts` tasks cache by default; `package.json` scripts do
  **not** (need `--cache` or `run.cache.scripts: true`). `&&` compounds split
  into separately cached sub-tasks; nested `vp run` inlines. Concurrency 4
  (`--concurrency-limit`, `VP_RUN_CONCURRENCY_LIMIT`); `--parallel` ignores
  `dependsOn`. Filtering mirrors pnpm `--filter` syntax; `-r`/`-t`/`-w` for
  recursive/transitive/root.
- Root ergonomics: `vp dev`/`build`/`pack` at a workspace root open a package
  picker (or require `-C <dir>`/`defaultPackage`); in non-interactive shells
  they exit 1 with a package listing (/guide/monorepo).

## Cloudflare compatibility — evidence and limits

Vendor claim only: the homepage asserts "First-class support on Vercel,
Netlify, Cloudflare & more" and Nitro pairing for deploy targets
(<https://viteplus.dev/>). There is no dedicated Cloudflare docs page. Actual
evidence from the issue tracker and registry:

- `vite` resolves via the `@voidzero-dev/vite-plus-core` alias, so a Vite
  plugin whose peer range covers Vite 8 (e.g. `@cloudflare/vite-plugin`
  `^6.1 || ^7 || ^8`) can resolve — the alias exists precisely so plugins keep
  working (/guide/local-cli, /guide/migrate-rules). Peer-range satisfaction is
  not behavioral verification.
- **Vitest is the sharp edge.** Vite+ pins `vitest@5.0.3` inside `vite-plus`;
  `@cloudflare/vitest-pool-workers@0.20.1` peers `vitest`, `@vitest/runner`,
  `@vitest/snapshot` at `^4.1.0` only, and the package is deprecated in favor
  of `@cloudflare/vitest-plugin` (`1.4.0`, peers `vitest ^4.1.0 || ^5.0.0`) —
  registry metadata, 2026-10-12. So the workerd test pool is **incompatible
  with Vite+ 1.x as-is**; the renamed plugin's `^5.0.0` range admits the
  bundled version, but migrating pool→plugin is an integration change whose
  test-suite outcome is unverified here.
- Closed evidence of friction: issue
  <https://github.com/voidzero-dev/vite-plus/issues/1076> — `vp test` crashed
  with `@cloudflare/vitest-pool-workers` while plain `vitest run` passed
  (dual-runner identity through the `vite-plus/test` shim; reporter's
  workaround was inlining `vite-plus` in `test.server.deps`, maintainers
  addressed the 0.2.0 path). Issue 831 fixed a `nitro cloudflare_module`
  CJS interop failure.
- Open evidence of friction: issue 1671 (React module duplication under
  workerd SSR + `@cloudflare/vite-plugin`), issue 2481 (dev server restart
  deadlock under `@cloudflare/vite-plugin` when a request straddles the
  restart, "bundled-dev/rolldown pipeline implicated"). Both open as of
  2026-10-12.
- Strategic context: VoidZero is joining Cloudflare (2026-06-04 post), and
  Cloudflare's own `vinext` is a listed adopter — directional support exists,
  but current releases still carry the open defects above.

## CI

- `voidzero-dev/setup-vp` is the supported path for **GitHub Actions, GitLab
  CI/CD, and Azure Pipelines only**: installs `vp`, Node, PM, runs `vp install`,
  caches PM data. Pin an exact release or SHA — the floating `v1` tag is frozen
  and no longer updated (`vp migrate` rewrites `setup-vp@v1` refs). GitLab
  needs a Node image and its own `cache:`; Azure uses `UseNode@1`/`Cache@2`
  (/guide/ci).
- **CircleCI/other**: no `setup-vp`; use the `ghcr.io/voidzero-dev/vite-plus`
  image or the curl installer inside a job (`VP_NODE_MANAGER=no` for pure
  toolchain use), `vp install --frozen-lockfile`, then commands
  (/guide/docker — which names CircleCI among container-CI targets).
- Task-cache persistence across CI runs exists only as the experimental
  GitHub `actions/cache` recipe noted above; on other CI it is an exercise for
  the reader.

## Repository fit — pre-migration Meltiply

**Recommendation: evaluate in an isolated branch, not a wholesale migration
on the strength of the homepage.** The consolidation benefit is credible, but
compatibility and performance on Meltiply remain untested. Do not run
`vp migrate frontend/app`: the documented migrator requires the workspace root.

| Area                   | Observed repository state                                                                                                                                                                                                                        | Assessment                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build                  | [App manifest](../../frontend/app/package.json) already pins Vite 8.2.0 and Cloudflare Vite plugin 1.63.0. [Vite config](../../frontend/app/vite.config.ts) includes root-env loading, custom plugins, and React deduplication.                  | The webpack-relative speed claim is not evidence of an incremental benefit here. Preserve custom behavior and exercise Cloudflare dev/restart/build paths.                                                                                             |
| Runtime / PM           | [Root manifest](../../package.json) pins Bun 1.4.2 and permits Node `>=24.0.0 <25`.                                                                                                                                                              | Bun is supported as a PM; Vite+'s Node 24 requirement starts at 24.11.0, narrower than the repo's engine range. Node management does not replace explicit Bun invocations in scripts.                                                                  |
| Worker tests           | [API Worker manifest](../../workers/api/package.json) pins Vitest 4.1.11 and `@cloudflare/vitest-pool-workers` 0.20.1.                                                                                                                           | Concrete peer incompatibility with bundled Vitest 5.0.3. Migrating to the renamed Cloudflare plugin and verifying Workers tests is a prerequisite for a unified test cutover.                                                                          |
| Lint                   | Pre-migration root and frontend ESLint configs enforced type-aware rules, inline boundary/color/low-motion policies, and `@shadcn/lint`.                                                                                                         | No automatic parity guarantee. Inventory every enabled rule and prove equivalent diagnostics before removing ESLint; do not drop policies to fit Oxlint.                                                                                               |
| Framework / formatting | [The unified public site](../../frontend/public/package.json) uses Astro for landing and docs.                                                                                                                                                   | `vp dev` is not `astro dev`; framework scripts must remain framework commands. Oxfmt's plugin gap prevents a complete Prettier cutover for `.astro` files.                                                                                             |
| Task orchestration     | [Turbo config](https://github.com/MeltiplyOrg/meltiply/blob/483537f1561c33cec21ab0daf028a21df61f7f91/turbo.json) declared dependency ordering, inputs, and outputs, including docs-specific content inputs, before removal in the Vite+ cutover. | Vite Task requires explicit equivalence checks for dependency order, outputs, environment, and cache invalidation. Remote caching is not available in Vite Task; this research did not establish whether Meltiply currently uses Turbo remote caching. |
| Gates                  | [Root scripts](../../package.json) include Knip, contract generation/checking, Workers tooling, shell/Node tests, and a comprehensive Cloudflare gate.                                                                                           | `vp check` cannot replace `cloudflare:check` or the affected workspace gates. It covers static formatting/lint/types only.                                                                                                                             |

If adoption is pursued, measure the existing commands first, then compare the
same workloads after migration in an isolated branch. Acceptance should include
all existing gates, equivalent custom lint enforcement, workerd tests, Astro
checks, staging/production builds, and env-sensitive cache invalidation. This
research installed nothing and changed no manifests, lockfiles, or application
configuration.

## Pre-migration uncertainties

1. Whether `vp check`'s tsgolint type-check diagnostics match the existing
   TypeScript 5.9 checks on this codebase (different compiler; `baseUrl`
   is a documented incompatibility, not an exhaustive list of differences).
2. Whether the frontend's inline boundary/color rules port cleanly to an
   Oxlint JS plugin (alpha API; silent-drop migration bug open).
3. Whether `@cloudflare/vitest-plugin` actually runs this repo's workerd pool
   tests under `vp test` — peer range admits it; runtime behavior unproven,
   with historical dual-runner crashes in this exact integration.
4. Whether `@cloudflare/vite-plugin`'s runtime behavior under Vite+/Rolldown
   is clean for this app — open issues 1671/2481 concern it.
5. Oxfmt output parity on this repo's Prettier 3.6.2 config (custom width/
   plugins); `printWidth` default differs (100 vs 80) until configured.
6. Whether rewritten `vite-plus/test*` imports and preserved upstream module
   augmentations resolve to one runner identity across all test integrations.
   Source/API compatibility on this repository is untested.

## Migration implementation

The root [Vite+ configuration](../../vite.config.ts) enumerates the previous
ESLint policies explicitly, including frontend boundary, React Hooks, and shadcn
rules. Oxlint's additional correctness preset is not part of that inventory.
Astro files retain their existing workspace-check coverage rather than acquiring
an unsupported plain-JavaScript lint interpretation.

Frontend lint runs from the repository root: Vite+ rejects `..` in file-selection
arguments, so the workspace command selects `frontend/app` and `frontend/shared`
using root-relative paths instead of passing `../shared`.

The [Bun dependency patch](../../patches/@shadcn%252Flint@0.1.0.patch) fixes
`@shadcn/lint` component lookup: resolving one imported component previously
enumerated every export in its re-export barrels. CPU profiling found repeated
`stat`/`realpath` calls in that traversal on the WSL-mounted repository.
The patch follows only the requested name, preserving explicit-export precedence,
star-export order, cycle handling, and consulted-module cache invalidation.
Keep the patch registered in the root manifest and lockfile so frozen CI installs
apply the same implementation. Reevaluate it when upgrading `@shadcn/lint`.
CircleCI routes root lint-plugin and dependency-patch changes to both application
lanes, alongside the shared Vite+ configuration and lockfile. Knip explicitly
discovers the HTML-linked stylesheet and alternate Worker Vitest configurations;
those are runtime entry points, not dead-code exclusions.

API unit/contract suites and both Workers' PostgreSQL integration suites share an
offline-collector fixture for the local Tempo export endpoint. It rejects only
trace exports immediately, keeping native fetch
for other requests and preserving the best-effort tracing failure path without
requiring the optional observability Compose profile.

Runtime verification uses the pinned Node 24 release and Linux-native filesystem
storage. On WSL, Windows-mounted source and dependency trees can dominate runtime
even after the lint traversal fix; see the [setup guidance](../../README.md).
The migrated frontend suite, custom lint policies, package/Worker coverage gates,
workerd tests, and production/framework builds have been exercised successfully.
Post-migration, Prettier and Turbo were replaced by Oxfmt (`vp fmt`) and Vite Task
(`vp run --cache`) respectively; TypeScript 7 replaced tsc for non-Astro
workspaces.

## Sources

Official documentation (retrieved 2026-10-12):

- [Overview](https://viteplus.dev/guide), [global CLI](https://viteplus.dev/guide/global-cli), [local CLI](https://viteplus.dev/guide/local-cli), [environment](https://viteplus.dev/guide/env).
- [Migration](https://viteplus.dev/guide/migrate), [migration rules](https://viteplus.dev/guide/migrate-rules), [Vitest 5 compatibility](https://viteplus.dev/guide/vitest-v5).
- [Check](https://viteplus.dev/guide/check), [lint](https://viteplus.dev/guide/lint), [format](https://viteplus.dev/guide/fmt), [troubleshooting](https://viteplus.dev/guide/troubleshooting).
- [Tasks](https://viteplus.dev/guide/run), [cache](https://viteplus.dev/guide/cache), [automatic tracking](https://viteplus.dev/guide/automatic-data-tracking), [monorepos](https://viteplus.dev/guide/monorepo).
- [CI](https://viteplus.dev/guide/ci), [experimental GitHub task cache](https://viteplus.dev/guide/github-actions-cache), [Docker](https://viteplus.dev/guide/docker).

Release, licensing, and integration evidence:

- [Original announcement](https://voidzero.dev/posts/announcing-vite-plus), [alpha](https://voidzero.dev/posts/announcing-vite-plus-alpha), [beta](https://voidzero.dev/posts/announcing-vite-plus-beta), [1.0](https://voidzero.dev/posts/announcing-vite-plus-1-0), [VoidZero / Cloudflare](https://voidzero.dev/posts/voidzero-cloudflare).
- [Repository](https://github.com/voidzero-dev/vite-plus), [MIT license](https://github.com/voidzero-dev/vite-plus/blob/main/LICENSE), [v1.1.0 release](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.1.0).
- Issues [831](https://github.com/voidzero-dev/vite-plus/issues/831), [1076](https://github.com/voidzero-dev/vite-plus/issues/1076), [1671](https://github.com/voidzero-dev/vite-plus/issues/1671), [2231](https://github.com/voidzero-dev/vite-plus/issues/2231), [2481](https://github.com/voidzero-dev/vite-plus/issues/2481). Issue reports are integration evidence, not proof that every configuration is affected.
- [Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins), [ESLint migration](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint), [Oxfmt language support](https://oxc.rs/docs/guide/usage/formatter/language-support), [unsupported formatter features](https://oxc.rs/docs/guide/usage/formatter/unsupported-features).
- Published metadata: [Vite+ 1.1.0](https://registry.npmjs.org/vite-plus/1.1.0), [Workers pool 0.20.1](https://registry.npmjs.org/@cloudflare/vitest-pool-workers/0.20.1), [Workers plugin 1.4.0](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.4.0), [Cloudflare Vite plugin 1.63.0](https://registry.npmjs.org/@cloudflare/vite-plugin/1.63.0).
