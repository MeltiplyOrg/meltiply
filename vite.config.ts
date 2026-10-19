import { defineConfig } from "vite-plus";

// Vite+ lint (Oxlint) configuration.
//
// `vp lint`/`vp check` only ever read THIS lint block — nested package configs
// cannot override it — so the policies that used to live in the deleted root
// `eslint.config.mjs` (packages/workers) and `frontend/eslint.config.mjs`
// (frontend/app + frontend/shared) are consolidated here:
//
// - Baseline `rules` + the TypeScript/JS `overrides` mirror the generated
//   migration of the old root config (eslint:recommended + tseslint
//   recommended + the packages/workers hardening rules), with two scoping
//   corrections: `no-unused-expressions` and `no-array-constructor` were
//   generated globally but only ran on TS files before (eslint-recommended
//   disables both under the TS parser), so they are re-scoped to TS files
//   below. The `no-var`/`prefer-const`/`prefer-rest-params`/`prefer-spread`
//   additions the migrator emitted were never enabled by the old configs and
//   are dropped to keep the policy identical.
// - The `frontend/**` entries carry over everything `frontend/eslint.config.mjs`
//   enforced, one override per former config block (ordered like ESLint:
//   later matching overrides win). That includes the custom `boundaries/*`
//   plugin, the `@shadcn/lint` design-system rules, and the
//   `eslint-plugin-react-hooks` recommended set — all via `jsPlugins` so the
//   rule semantics are the upstream implementations, not approximations.
//
// `eslint-plugin-react-hooks` is aliased `react-hooks-js` because Oxlint
// reserves the `react`/`react-hooks` namespaces for its own built-in rules.
// Loading the real plugin (a conformance-tested JS plugin) keeps the two
// compiler-era rules Oxlint has no native equivalent for (`config`, `gating`)
// and the exact upstream behavior for the rest.

// Keeps UI imports on shared data boundaries, icon primitives, and the single
// Sileo notification store. Both no-restricted-imports overrides reference
// this list so the broad and component scopes cannot drift apart.
const frontendRestrictedImports = [
  {
    name: "@meltiply/database",
    message: "Database client imports are blocked from UI and frontend application layers.",
  },
  {
    name: "iconoir-react",
    message:
      "Use lucide-react for product UI icons. Iconoir is reserved for src/lib/platforms.ts brand-logo mapping.",
  },
  ...["sonner", "react-hot-toast", "react-toastify", "sileo"].map((name) => ({
    name,
    message:
      "Use the shared Meltiply toast API from @meltiply/ui/toast (Toaster: @meltiply/ui/sileo).",
  })),
];

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "**/.next/",
      "packages/contracts/src/generated/",
      "workers/*/worker-configuration.d.ts",
      ".gitleaksignore",
      "**/.wrangler/",
      "**/playwright-report/",
      "**/test-results/",
      "frontend/app/**/*.md",
      "frontend/app/**/cloudflare-env.d.ts",
    ],
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn"],
    categories: {
      // Legacy recommended rules are enumerated below. Enabling Oxlint's
      // unrelated preset would add new policies, including type-aware checks
      // on Node test registration that the old ESLint config never enforced.
      correctness: "off",
    },
    options: {
      typeAware: true,
      typeCheck: true,
      // Repo policy is zero-warning lint (CONTRIBUTING: "zero-warning" gate).
      // Setting it here makes `vp check` and bare `vp lint` fail on warnings
      // too — the root and frontend scripts still pass --deny-warnings
      // explicitly for clarity.
      denyWarnings: true,
      // Match ESLint 9's default: stale disable directives warn (and therefore
      // fail the zero-warning gate above).
      reportUnusedDisableDirectives: "warn",
    },
    env: {
      builtin: true,
    },
    ignorePatterns: [
      "**/dist/**",
      "**/.wrangler/**",
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "packages/contracts/src/generated/**",
      // Public JavaScript/TypeScript is linted; generated Astro types are not.
      "frontend/public/.astro/**",
      // ESLint had no Astro parser or matching .astro config. Preserve that
      // scope; Astro's existing workspace checks own component validation.
      "**/*.astro",
      // Artifact/generated ignores carried over from frontend/eslint.config.mjs
      // (paths re-rooted; `**/dist/**` and `**/.wrangler/**` already cover two
      // of the original six).
      "frontend/app/coverage/**",
      "frontend/app/playwright-report/**",
      "frontend/app/test-results/**",
      "frontend/app/cloudflare-env.d.ts",
      ".agents/**",
      // The Claude skills symlink aliases .agents; Oxlint follows that alias.
      ".claude/**",
      ".opencode/**",
      ".kiro/**",
      ".omp/**",
    ],
    rules: {
      "constructor-super": "error",
      "for-direction": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-case-declarations": "error",
      "no-class-assign": "error",
      "no-compare-neg-zero": "error",
      "no-cond-assign": "error",
      "no-const-assign": "error",
      "no-constant-binary-expression": "error",
      "no-constant-condition": "error",
      "no-control-regex": "error",
      "no-debugger": "error",
      "no-delete-var": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": "error",
      "no-empty-character-class": "error",
      "no-empty-pattern": "error",
      "no-empty-static-block": "error",
      "no-ex-assign": "error",
      "no-extra-boolean-cast": "error",
      "no-fallthrough": "error",
      "no-func-assign": "error",
      "no-global-assign": "error",
      "no-import-assign": "error",
      "no-invalid-regexp": "error",
      "no-irregular-whitespace": "error",
      "no-loss-of-precision": "error",
      "no-misleading-character-class": "error",
      "no-new-native-nonconstructor": "error",
      "no-nonoctal-decimal-escape": "error",
      "no-obj-calls": "error",
      "no-prototype-builtins": "error",
      "no-redeclare": "error",
      "no-regex-spaces": "error",
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-shadow-restricted-names": "error",
      "no-sparse-arrays": "error",
      "no-this-before-super": "error",
      "no-undef": "error",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "no-unused-labels": "error",
      "no-unused-private-class-members": "error",
      "no-unused-vars": "error",
      "no-useless-backreference": "error",
      "no-useless-catch": "error",
      "no-useless-escape": "error",
      "no-with": "error",
      "require-yield": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      // Off globally: tseslint's recommended config only ever ran
      // no-unused-expressions/no-array-constructor on TS files (the core
      // variants are in its eslint-recommended OFF list). Enabled for TS in
      // the override below.
      "no-unused-expressions": "off",
      "typescript/ban-ts-comment": "error",
      "typescript/no-duplicate-enum-values": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-extra-non-null-assertion": "error",
      "typescript/no-misused-new": "error",
      "typescript/no-namespace": "error",
      "typescript/no-non-null-asserted-optional-chain": "error",
      "typescript/no-require-imports": "error",
      "typescript/no-this-alias": "error",
      "typescript/no-unnecessary-type-constraint": "error",
      "typescript/no-unsafe-declaration-merging": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-wrapper-object-types": "error",
      "typescript/prefer-as-const": "error",
      "typescript/prefer-namespace-keyword": "error",
      "typescript/triple-slash-reference": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        // TS files: mirror tseslint's eslint-recommended adjustments — core
        // checks TypeScript already covers are off, while the TS variants of
        // no-unused-expressions/no-array-constructor become errors.
        files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
        rules: {
          "constructor-super": "off",
          "getter-return": "off",
          "no-array-constructor": "error",
          "no-class-assign": "off",
          "no-const-assign": "off",
          "no-dupe-class-members": "off",
          "no-dupe-keys": "off",
          "no-func-assign": "off",
          "no-import-assign": "off",
          "no-new-native-nonconstructor": "off",
          "no-obj-calls": "off",
          "no-redeclare": "off",
          "no-setter-return": "off",
          "no-this-before-super": "off",
          "no-undef": "off",
          "no-unreachable": "off",
          "no-unsafe-negation": "off",
          "no-unused-expressions": "error",
          "no-with": "off",
        },
      },
      {
        // Scripts deliberately match literal control characters and whitespace
        // in external output/CI YAML; keep the bug-catching rules, drop style.
        files: ["**/*.{js,mjs,cjs}"],
        env: {
          node: true,
        },
        rules: {
          "no-control-regex": "off",
          "no-regex-spaces": "off",
          "no-useless-escape": "off",
        },
      },
      {
        // k6 injects __ENV into its script runtime, rather than Node's process.env.
        files: ["scripts/cloudflare-local/k6/**/*.js"],
        globals: {
          __ENV: "readonly",
        },
      },
      {
        // packages/ + workers/ hardening rules (AUD-001/034/055). `plugins`
        // REPLACES the base plugin list in Oxlint overrides, so the import
        // plugin must be added to the base set, not listed alone.
        files: ["packages/**/*.ts", "workers/**/*.ts"],
        plugins: ["oxc", "typescript", "unicorn", "import"],
        env: {
          node: true,
        },
        rules: {
          // Belt-and-braces under tsconfig noUnusedLocals/noUnusedParameters
          // (AUD-001): keeps underscore-prefixed params allowed, matching tsc.
          "no-unused-vars": [
            "error",
            {
              argsIgnorePattern: "^_",
              varsIgnorePattern: "^_",
              caughtErrors: "none",
            },
          ],
          // AUD-055: hardened after the `as unknown as` cleanup; the only
          // remaining assertions are justified and carry file-level disables.
          "typescript/no-unnecessary-type-assertion": "error",
          "typescript/ban-ts-comment": "error",
          // Catches always-truthy branches like `if (queryResult)` (AUD-034).
          // Oxlint ships a single TS-aware core implementation, so the
          // @typescript-eslint extension rule maps to the same eslint name
          // already enabled for *.ts above; kept here for intent.
          "no-unused-expressions": "error",
          // Matches the repo's verbatimModuleSyntax style (inline `type` modifiers).
          "typescript/consistent-type-imports": "error",
          "import/no-duplicates": "error",
          // Sanitization regexes deliberately strip control characters from
          // provider/user content; the literal \x00-\x1f classes are the point.
          "no-control-regex": "off",
        },
      },
      {
        // Workers must use the observability package, not console output.
        files: ["workers/**/*.ts"],
        rules: {
          "no-console": "error",
        },
      },
      {
        // Browser + node globals for frontend application, shared and public-site code.
        files: [
          "frontend/app/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
          "frontend/shared/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
          "frontend/public/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
        ],
        env: {
          browser: true,
          node: true,
        },
      },
      {
        // Frontend TS relaxations from the old config's global block:
        // `any` is permitted and unused-vars keeps the underscore convention.
        files: ["frontend/app/**/*.{ts,tsx,mts,cts}", "frontend/shared/**/*.{ts,tsx,mts,cts}"],
        rules: {
          "typescript/no-explicit-any": "off",
          "no-unused-vars": [
            "error",
            {
              argsIgnorePattern: "^_",
              varsIgnorePattern: "^_",
              caughtErrors: "none",
            },
          ],
        },
      },
      {
        // eslint-plugin-react-hooks flat/recommended (v7), loaded verbatim as
        // a JS plugin under the `react-hooks-js` alias — identical severities:
        // exhaustive-deps, incompatible-library and unsupported-syntax warn,
        // everything else errors.
        files: ["frontend/app/**", "frontend/shared/**", "frontend/public/**"],
        rules: {
          "react-hooks-js/rules-of-hooks": "error",
          "react-hooks-js/exhaustive-deps": "warn",
          "react-hooks-js/static-components": "error",
          "react-hooks-js/use-memo": "error",
          "react-hooks-js/preserve-manual-memoization": "error",
          "react-hooks-js/incompatible-library": "warn",
          "react-hooks-js/immutability": "error",
          "react-hooks-js/globals": "error",
          "react-hooks-js/refs": "error",
          "react-hooks-js/set-state-in-effect": "error",
          "react-hooks-js/error-boundaries": "error",
          "react-hooks-js/purity": "error",
          "react-hooks-js/set-state-in-render": "error",
          "react-hooks-js/unsupported-syntax": "warn",
          "react-hooks-js/config": "error",
          "react-hooks-js/gating": "error",
        },
      },
      {
        // Database, icon, and notification-store imports are banned from
        // feature code (iconoir is reserved for the brand-logo mapping in
        // platforms.ts; toast APIs funnel through the shared Sileo wrapper).
        files: ["frontend/app/src/**/*.{ts,tsx}", "frontend/shared/**/*.{ts,tsx}"],
        excludeFiles: ["frontend/app/src/lib/platforms.ts", "frontend/app/src/**/*.test.{ts,tsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: frontendRestrictedImports,
            },
          ],
        },
      },
      {
        // Feature components additionally ban raw Radix imports and retired
        // app-local component paths (the canonical @meltiply/ui wrapper owns
        // motion/focus/styling), native `alert` notifications, and direct
        // clipboard access so feedback stays in the shared Sileo store and
        // copy-text helper. As in ESLint flat config, this later-matching
        // override replaces no-restricted-imports for these files, so it must
        // repeat the shared path list.
        files: ["frontend/app/src/components/**/*.{ts,tsx}"],
        excludeFiles: ["frontend/app/src/**/*.test.{ts,tsx}"],
        rules: {
          "no-alert": "error",
          "no-restricted-properties": [
            "error",
            {
              object: "navigator",
              property: "clipboard",
              message:
                "Use @meltiply/ui/copy-text so clipboard access and denied-access handling stay consistent.",
            },
          ],
          "no-restricted-imports": [
            "error",
            {
              paths: frontendRestrictedImports,
              patterns: [
                {
                  group: ["@radix-ui/*", "radix-ui", "radix-ui/*"],
                  message:
                    "Reuse the canonical @meltiply/ui wrapper so motion, focus, and styling stay consistent.",
                },
                {
                  group: [
                    "@/components/ui",
                    "@/components/ui/*",
                    "@/components/atoms",
                    "@/components/atoms/*",
                    "@/components/primitives/sliding-highlight",
                  ],
                  message:
                    "Shared UI lives in @meltiply/ui/<basename>; extend it instead of adding app-local copies.",
                },
                {
                  group: ["@meltiply/ui/src/**", "@meltiply/ui/components/**"],
                  message: "Use the flat @meltiply/ui/<basename> export.",
                },
                {
                  group: [
                    "@meltiply/ui/dialog",
                    "@meltiply/ui/alert-dialog",
                    "@meltiply/ui/right-side-dialog",
                  ],
                  message:
                    "Meltiply has two dialog types: @meltiply/ui/center-dialog (+ center-alert-dialog for confirmations) and @meltiply/ui/side-dialog.",
                },
              ],
            },
          ],
        },
      },
      {
        // platforms.ts is the sanctioned iconoir consumer; the database ban
        // still applies.
        files: ["frontend/app/src/lib/platforms.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "@meltiply/database",
                  message:
                    "Database client imports are blocked from UI and frontend application layers.",
                },
              ],
            },
          ],
        },
      },
      {
        // @shadcn/lint design-system rules on feature code (tests excluded).
        // The `shadcn.ui` setting and `note` live in top-level `settings`
        // because Oxlint overrides cannot carry settings.
        files: ["frontend/app/src/**/*.{ts,tsx}", "frontend/shared/**/*.{ts,tsx}"],
        excludeFiles: ["frontend/app/src/**/*.test.{ts,tsx}"],
        rules: {
          "shadcn/no-raw-colors": ["error", { allow: ["shadow-*"] }],
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "backdrop-blur-[2px]",
                "stroke-[1.5]",
                "stroke-[3]",
                "text-[9px]",
                "text-[10px]",
                "text-[10.5px]",
                "text-[11px]",
                "text-[11.5px]",
                "text-[12px]",
                "text-[12.5px]",
                "text-[13px]",
                "text-[13.5px]",
                "text-[14px]",
                "text-[15px]",
              ],
            },
          ],
          "shadcn/no-inline-styles": "error",
          "shadcn/no-unknown-classes": "error",
          "shadcn/require-static-classes": "error",
        },
      },
      {
        // Component-library directories own their geometry/motion styles: the
        // arbitrary-value and static-class bans lift, and inline styles are
        // narrowed to the animation/layout properties Motion needs.
        files: [
          "frontend/app/src/components/{ui,atoms,primitives,devbox}/**/*.{ts,tsx}",
          "frontend/shared/**/*.{ts,tsx}",
        ],
        rules: {
          "shadcn/no-arbitrary-values": "off",
          "shadcn/no-inline-styles": [
            "error",
            {
              allow: [
                "animation",
                "backgroundColor",
                "borderColor",
                "borderRadius",
                "gridTemplateColumns",
                "height",
                "left",
                "originX",
                "originY",
                "top",
                "transform",
                "transition",
                "transitionTimingFunction",
                "width",
              ],
            },
          ],
          "shadcn/require-static-classes": "off",
        },
      },
      {
        // plugs-view predates the shared component contract; only the animated
        // progress width is allowed inline.
        files: ["frontend/app/src/components/plugs/plugs-view.tsx"],
        rules: {
          "shadcn/no-inline-styles": ["error", { allow: ["animation", "width"] }],
        },
      },
      {
        // EvilCharts registry source is vendored third-party implementation
        // (recorded in THIRD_PARTY_NOTICES) and is reviewed as code, not
        // rewritten into Meltiply's authored-style contract. Its SVG geometry,
        // tooltip internals, and loading chrome legitimately need raw SVG
        // colors and computed inline positions; authored feature code keeps
        // the design-system rules. The analytics page still supplies the
        // series token (var(--accent)) and translated labels.
        files: ["frontend/app/src/components/evilcharts/**/*.{ts,tsx}"],
        rules: {
          "shadcn/no-arbitrary-values": "off",
          "shadcn/no-inline-styles": "off",
          "shadcn/no-raw-colors": "off",
          "shadcn/no-unknown-classes": "off",
          "shadcn/require-static-classes": "off",
          "react-hooks-js/exhaustive-deps": "off",
          "react-hooks-js/set-state-in-effect": "off",
        },
      },
      {
        // Custom boundary policies (ported 1:1 into lint/boundaries-plugin.mjs):
        // adapter-only env/fetch/Effect.run access and shared UI control/color contracts.
        files: ["frontend/app/src/**/*.{ts,tsx}", "frontend/shared/**/*.{ts,tsx}"],
        rules: {
          "boundaries/no-effect-run": "error",
          "boundaries/no-direct-env": "error",
          "boundaries/no-direct-fetch": "error",
          "boundaries/no-raw-interactive-elements": "error",
          "boundaries/no-provider-color-leak": "error",
          "boundaries/no-raw-palette-utility": "error",
          "boundaries/no-canonical-ui-clones": "error",
        },
      },
    ],
    settings: {
      // Design-system contract consumed by the @shadcn/lint rules above.
      shadcn: {
        ui: ["@/components/ui", "@/components/atoms", "@/components/primitives", "@meltiply/ui"],
        note: "Use the existing Meltiply tokens, component variants, and primitives; do not introduce a route-specific visual treatment.",
      },
    },
    jsPlugins: [
      {
        name: "boundaries",
        specifier: "./lint/boundaries-plugin.mjs",
      },
      {
        name: "shadcn",
        specifier: "@shadcn/lint",
      },
      {
        name: "react-hooks-js",
        specifier: "eslint-plugin-react-hooks",
      },
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
