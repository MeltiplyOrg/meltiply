import { defineConfig } from "vite-plus";

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
      ".agents/skills/",
      "frontend/app/**/*.md",
      "frontend/app/**/cloudflare-env.d.ts",
    ],
  },
  lint: {
    plugins: ["oxc", "typescript", "unicorn"],
    categories: {
      correctness: "off",
    },
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
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
      "frontend/public/.astro/**",
      "**/*.astro",
      "frontend/app/coverage/**",
      "frontend/app/playwright-report/**",
      "frontend/app/test-results/**",
      "frontend/app/cloudflare-env.d.ts",
      ".agents/**",
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
      "oxc/no-accumulating-spread": "error",
      "landmines/no-shared-signal": "error",
      "landmines/strict-msw": "error",
    },
    overrides: [
      {
        files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
        rules: {
          "typescript/no-floating-promises": "error",
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
        files: ["scripts/cloudflare-local/k6/**/*.js"],
        globals: {
          __ENV: "readonly",
        },
      },
      {
        files: ["packages/**/*.ts", "workers/**/*.ts"],
        plugins: ["oxc", "typescript", "unicorn", "import"],
        env: {
          node: true,
        },
        rules: {
          "no-unused-vars": [
            "error",
            {
              argsIgnorePattern: "^_",
              varsIgnorePattern: "^_",
              caughtErrors: "none",
            },
          ],
          "typescript/no-unnecessary-type-assertion": "error",
          "typescript/ban-ts-comment": "error",
          "no-unused-expressions": "error",
          "typescript/consistent-type-imports": "error",
          "import/no-duplicates": "error",
          "no-control-regex": "off",
        },
      },
      {
        files: ["workers/**/*.ts"],
        rules: {
          "no-console": "error",
        },
      },
      {
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
        files: ["frontend/app/**/*.{ts,tsx,mts,cts}", "frontend/shared/**/*.{ts,tsx,mts,cts}"],
        rules: {
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
      {
        files: [
          "packages/**/*.{ts,tsx,mts,cts,mjs,js}",
          "workers/**/*.{ts,tsx,mts,cts,mjs,js}",
          "frontend/**/*.{ts,tsx,mts,cts,mjs,js}",
          "scripts/**/*.{ts,tsx,mts,cts,mjs,js}",
          "lint/**/*.{ts,tsx,mts,cts,mjs,js}",
          "vite.config.ts",
        ],
        rules: {
          "meltiply/no-chained-type-assertions": "error",
          "meltiply/no-error-message-classification": "error",
          "meltiply/no-platform-roster-literal": "error",
          "meltiply/no-sql-conditional-fragment": "error",
          "meltiply/no-codepoint-spread-length": "error",
          "meltiply/no-json-parse-cast": "error",
          "meltiply/no-time-derived-key": "error",
          "meltiply/no-export-star": "error",
          "meltiply/no-sql-date-column": "error",
          "meltiply/no-workerd-fs-module-cache": "error",
          "meltiply/no-throw-in-effect-gen": "error",
          "meltiply/no-worker-effect-run": "error",
          "meltiply/no-naive-redirect-prefix": "error",
          "meltiply/no-history-comments": "error",
          "meltiply/no-jsdoc-type-tags": "error",
          "meltiply/no-doc-comment-outside-package-contract": "error",
          "meltiply/no-banner-comments": "error",
          "meltiply/no-commented-out-code": "error",
        },
      },
      {
        files: [
          "packages/*/{src,test}/**/*.ts",
          "workers/*/{src,test,test-support}/**/*.ts",
          "frontend/app/src/**/*.{ts,tsx}",
          "frontend/shared/**/*.{ts,tsx}",
          "scripts/lib/*.ts",
          "scripts/selfhost/*.ts",
        ],
        rules: {
          "meltiply/prefer-error-message-helper": "error",
        },
      },
      {
        files: ["packages/*/src/**/*.ts", "workers/*/src/**/*.ts"],
        rules: {
          "meltiply/no-session-advisory-lock": "error",
        },
      },
      {
        files: ["frontend/app/src/components/composer/**/*.{ts,tsx}"],
        rules: {
          "landmines/no-silent-catch": "error",
        },
      },
      {
        files: ["frontend/app/src/lib/**/browser-cache.test.tsx"],
        rules: {
          "meltiply/no-promise-sleep": "error",
        },
      },
      {
        files: [
          "frontend/app/e2e/**/cache-smoke.mjs",
          "frontend/app/e2e/**/posts-composer.spec.ts",
        ],
        rules: {
          "landmines/no-fixed-sleep": "error",
        },
      },
      {
        files: ["frontend/app/e2e/**/posts-composer.spec.ts"],
        rules: {
          "landmines/no-unsignaled-poll": "error",
        },
      },
      {
        files: ["lint/codebase-plugin.test.mjs"],
        rules: {
          "meltiply/no-sql-date-column": "off",
        },
      },
    ],
    settings: {
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
        name: "meltiply",
        specifier: "./lint/codebase-plugin.mjs",
      },
      {
        name: "landmines",
        specifier: "@interfere/landmines",
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
