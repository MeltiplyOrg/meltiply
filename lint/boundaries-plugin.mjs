/**
 * Custom `boundaries/*` lint rules for frontend feature code.
 *
 * Loaded as an Oxlint JS plugin (`lint.jsPlugins` in the root vite.config.ts).
 * Oxlint's JS-plugin API is ESLint v9-compatible and supports everything these
 * rules use: esquery selectors (including regex attribute matchers), scope
 * analysis (`sourceCode.getScope`), `sourceCode.getText`, `context.filename`,
 * and `messageId`/`data` reporting. The rules stay syntactic — no type
 * information — because type-aware rules are unsupported inside JS plugins.
 *
 * A plain plugin object is exported instead of `definePlugin(...)` so the file
 * remains usable by both Oxlint and ESLint without a runtime dependency on
 * vite-plus.
 *
 * The UI-ownership rules (`no-raw-interactive-elements`,
 * `no-canonical-ui-clones`) share their canonical-name tables with the
 * `.astro` checker via `lint/ui-contract-lib.mjs`, so React and Astro surfaces
 * enforce one contract. Import-specifier policy lives in the root
 * `no-restricted-imports` overrides instead of a custom rule.
 */

import {
  CANONICAL_COMPONENT_STEMS,
  CANONICAL_FLAT_OWNERS,
  SANCTIONED_APP_COMPONENTS,
  normalizePath,
  normalizeStem,
  stemOf,
} from "./ui-contract-lib.mjs";

/**
 * Color-capable Tailwind utility families shared by both class-name color rules.
 *
 * A family that can carry a raw palette step can also carry a provider token, so
 * `no-raw-palette-utility` and `no-provider-color-leak` patrol the same surface:
 * surfaces (`bg`, `text`, `border` plus its directional sides, `ring`/`ring-offset`/
 * `inset-ring`, `divide`, `outline`), glyphs (`fill`, `stroke`, `caret`, `accent`,
 * `decoration`), gradient stops (`from`, `via`, `to`), and the shadow colors
 * (`shadow`, `inset-shadow`, `drop-shadow`).
 */
const colorUtilityFamilies =
  "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|fill|stroke|from|via|to|shadow|inset-shadow|drop-shadow|caret|accent|decoration|divide|outline";

/**
 * Default Tailwind palette hues accepted in the color slot of `no-raw-palette-utility`.
 *
 * Matching named hues instead of any `word-NN` fragment keeps numeric non-color
 * utilities — `bg-linear-45`, `bg-conic-90`, `divide-x-12`, `outline-offset-12` —
 * from being misread as palette steps while every real `hue-50…950` utility still
 * reports.
 */
const rawPaletteHues =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";

const providerColorLeakPattern = new RegExp(`(?:^|[\\s:])(?:${colorUtilityFamilies})-platform-`);
const rawPaletteUtilityPattern = new RegExp(
  `(?:^|[\\s:])(?:${colorUtilityFamilies})-(?:black|white|(?:${rawPaletteHues})-\\d{2,3})(?:\\/|\\s|!|$)`,
);

/**
 * Native interactive elements that the canonical control wrappers own. Member
 * expressions are checked against `RAW_INTERACTIVE_HOSTS` so `<motion.button>`
 * is flagged exactly like `<button>` — the animated spelling is the same raw
 * control with the same missing contract.
 */
const RAW_INTERACTIVE_TAGS = Object.freeze({
  button: true,
  input: true,
  select: true,
  textarea: true,
});
const RAW_INTERACTIVE_HOSTS = Object.freeze({
  motion: true,
  styled: true,
  animated: true,
});

const boundariesPlugin = {
  meta: { name: "boundaries" },
  rules: {
    "no-effect-run": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Effect execution (Effect.run*) is restricted to approved runtime boundary adapters (src/lib/effect/runtime.ts).",
        },
      },
      create(context) {
        const filename = context.filename ?? "";
        if (
          filename.includes("src/lib/effect/runtime.ts") ||
          filename.includes(".test.") ||
          filename.includes("src/test/")
        ) {
          return {};
        }
        return {
          "MemberExpression[object.name='Effect'][property.name=/^run(Promise|Sync|Fork|PromiseExit|SyncExit)$/]"(
            node,
          ) {
            context.report({ node, messageId: "restricted" });
          },
        };
      },
    },
    "no-direct-env": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Environment reads are restricted to the configuration adapter (src/lib/env.ts).",
        },
      },
      create(context) {
        const filename = context.filename ?? "";
        if (
          filename.includes("src/lib/env.ts") ||
          filename.includes(".test.") ||
          filename.includes("src/test/")
        ) {
          return {};
        }
        return {
          "MemberExpression[object.meta.name='import'][property.name='env']"(node) {
            context.report({ node, messageId: "restricted" });
          },
          "MemberExpression[object.name='process'][property.name='env']"(node) {
            context.report({ node, messageId: "restricted" });
          },
        };
      },
    },
    "no-direct-fetch": {
      meta: {
        type: "problem",
        messages: {
          restricted: "Direct fetch is restricted to designated HTTP/provider/telemetry adapters.",
        },
      },
      create(context) {
        const filename = context.filename ?? "";
        if (
          filename.includes("src/lib/api.ts") ||
          filename.includes("src/lib/auth-client.ts") ||
          filename.includes("src/lib/upload.ts") ||
          filename.includes("src/lib/frontend-telemetry.ts") ||
          // DevBox dev-tool: intentionally wraps globalThis.fetch to inject
          // latency/skeleton holds; never ships to production.
          filename.includes("src/components/devbox/network-throttle.ts") ||
          filename.includes("src/worker.ts") ||
          filename.includes(".test.") ||
          filename.includes("src/test/")
        ) {
          return {};
        }
        return {
          "CallExpression[callee.name='fetch']"(node) {
            context.report({ node, messageId: "restricted" });
          },
          "CallExpression[callee.property.name='fetch'][callee.object.name=/^(globalThis|window)$/]"(
            node,
          ) {
            context.report({ node, messageId: "restricted" });
          },
        };
      },
    },
    /**
     * Prevents feature code from bypassing the design-system control contracts.
     *
     * The canonical component library in `frontend/shared/src/components/`
     * owns raw controls: keyboard behavior, focus treatment, and tokenized
     * geometry. Feature code, and the retired `frontend/app/src/components/`
     * dirs that now hold only composition wrappers, must reuse those wrappers.
     * `<motion.button>`/`<styled.input>` member expressions count as the same
     * raw control — animating a tag does not make it a design-system control.
     */
    "no-raw-interactive-elements": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Use the matching component from @meltiply/ui so controls retain the shared interaction and visual contract.",
        },
      },
      create(context) {
        const filename = normalizePath(context.filename ?? "");
        if (
          filename.includes("/frontend/shared/src/components/") ||
          // DevBox's development-only diagnostic chrome is intentionally
          // bespoke; product atoms and navigation primitives do not share
          // this exemption.
          filename.includes("src/components/devbox/") ||
          filename.includes(".test.") ||
          filename.includes("src/test/")
        ) {
          return {};
        }
        return {
          JSXOpeningElement(node) {
            const name = node.name;
            const tag =
              name.type === "JSXIdentifier"
                ? name.name
                : name.type === "JSXMemberExpression" &&
                    name.object.type === "JSXIdentifier" &&
                    RAW_INTERACTIVE_HOSTS[name.object.name] === true
                  ? name.property.name
                  : null;
            if (tag !== null && RAW_INTERACTIVE_TAGS[tag] === true) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },
    /**
     * Blocks files that claim a canonical component's basename or sit in the
     * retired app component directories.
     *
     * File-level guardrail that cannot be dodged by import spelling: any
     * non-sanctioned file in `frontend/app/src/components/{ui,atoms,primitives}`
     * is a clone surface; elsewhere under `frontend/` a file whose stem
     * normalizes to a canonical component name (`Button.tsx` in a feature
     * dir, `BrandMark.astro` in landing) shadows the shared component. Inside
     * the flat-export dirs a stem owned by a different dir makes
     * `@meltiply/ui/<basename>` ambiguous. `CANONICAL_FLAT_OWNERS` also fails
     * closed for a clone that deletes the canonical file first.
     */
    "no-canonical-ui-clones": {
      meta: {
        type: "problem",
        messages: {
          retiredDir:
            "frontend/app/src/components/{{dir}}/ is retired: {{file}} is not a sanctioned app wrapper — move shared components to frontend/shared/src/components/ or keep app components in feature directories.",
          flatCollision:
            "{{file}} collides on the flat `@meltiply/ui/<basename>` namespace — `{{stem}}` is owned by {{owner}}. Rename it so each basename maps to exactly one component.",
          nameClone:
            "{{file}} re-implements the canonical component `{{stem}}` — import it from @meltiply/ui instead of cloning it locally.",
        },
      },
      create(context) {
        const filename = normalizePath(context.filename ?? "");
        if (filename.includes(".test.")) return {};
        return {
          Program(node) {
            const stem = stemOf(filename);
            const retired = filename.match(
              /\/frontend\/app\/src\/components\/(ui|atoms|primitives)\//,
            );
            if (retired) {
              if (SANCTIONED_APP_COMPONENTS[retired[1]]?.[stem] === true) return;
              context.report({
                node,
                messageId: "retiredDir",
                data: { dir: retired[1], file: stem },
              });
              return;
            }
            if (!filename.includes("/frontend/")) return;
            if (filename.includes("/frontend/shared/")) {
              const flat = filename.match(
                /\/frontend\/shared\/src\/components\/(ui|atoms|primitives)\//,
              );
              const owner = flat && CANONICAL_FLAT_OWNERS[normalizeStem(stem)];
              if (flat && owner && owner !== flat[1]) {
                context.report({
                  node,
                  messageId: "flatCollision",
                  data: { file: stem, stem, owner },
                });
              }
              return;
            }
            if (CANONICAL_COMPONENT_STEMS[normalizeStem(stem)] === true) {
              context.report({
                node,
                messageId: "nameClone",
                data: { file: stem, stem },
              });
            }
          },
        };
      },
    },
    /**
     * Reserves provider colors for PlatformIcon so product-state color remains semantic.
     *
     * Provider hues identify third-party services; a feature may name the provider but
     * must render its identity through the central platform primitive rather than restyling it.
     * The family alternation is shared with `no-raw-palette-utility` so every surface a
     * raw palette step could reach — including compound `inset-ring`, `inset-shadow`,
     * and `drop-shadow` — is equally closed to provider tokens. The class boundary
     * accepts `:` so variant prefixes (`hover:`, `dark:`) cannot smuggle a provider
     * utility past the check.
     */
    "no-provider-color-leak": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Provider color tokens are reserved for PlatformIcon. Use semantic product tokens or render <PlatformIcon>.",
        },
      },
      create(context) {
        const filename = context.filename ?? "";
        if (filename.includes("src/components/primitives/platform-icon.tsx")) return {};
        return {
          Literal(node) {
            if (typeof node.value === "string" && providerColorLeakPattern.test(node.value)) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },
    /**
     * Blocks direct palette-family utilities so every product color resolves through globals.css.
     *
     * Raw Tailwind families are not theme-aware and can make light and dark surfaces diverge;
     * design tokens preserve their semantic role across both themes. The alternation spans
     * every color-capable family — surfaces (`bg`, `text`, `border` plus its directional
     * sides, `ring`/`ring-offset`/`inset-ring`, `divide`, `outline`), glyphs (`fill`,
     * `stroke`, `caret`, `accent`, `decoration`), gradient stops (`from`, `via`, `to`),
     * and the shadow colors (`shadow`, `inset-shadow`, `drop-shadow`) — while size-only
     * members such as `border-t-2`, `shadow-md`, or `drop-shadow-lg` still pass because
     * the color slot only matches `black`, `white`, or a named default-palette
     * `hue-50…950` step. Naming the hues keeps numeric non-color utilities like
     * `bg-linear-45`, `bg-conic-90`, `divide-x-12`, and `outline-offset-12` from being
     * misread as palette steps. The class boundary accepts `:` and the terminator
     * accepts `!` so stacked or arbitrary variant prefixes and the important modifier
     * cannot smuggle a raw palette utility past the check.
     */
    "no-raw-palette-utility": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Use a semantic color token declared in src/app/globals.css instead of a raw Tailwind palette utility.",
        },
      },
      create(context) {
        return {
          Literal(node) {
            if (typeof node.value === "string" && rawPaletteUtilityPattern.test(node.value)) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },
  },
};

export default boundariesPlugin;
