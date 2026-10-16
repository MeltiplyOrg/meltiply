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
 * Animation-triggering props on `motion.*` elements that must be low-motion aware.
 *
 * Each entry either renders inert (`false`/`undefined`/`null`) or references the
 * effective preference (`lowMotion` identifier or a `useMotionPreference()` call)
 * so the shared toggle — manual OR OS reduced-motion — can suppress it. `animate`
 * is handled separately: object literals and variant labels are triggers, while
 * identifiers resolving to `useAnimation()`/`useIconLoop()` are driver-gated
 * because the hook owns the preference internally.
 */
const motionTriggerProps = new Set([
  "initial",
  "exit",
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileDrag",
  "whileInView",
  "layout",
  "layoutId",
  "drag",
]);

/**
 * Returns true when an expression is statically inert for animation purposes:
 * `false`, `undefined`, or `null` — the values Motion treats as "no animation".
 */
function isInertExpression(node) {
  return (
    (node.type === "Literal" && (node.value === false || node.value === null)) ||
    (node.type === "Identifier" && node.name === "undefined") ||
    (node.type === "UnaryExpression" && node.operator === "void")
  );
}

/**
 * Returns true when an expression's source references the effective low-motion
 * preference — the `lowMotion` identifier (destructured from
 * `useMotionPreference()` or passed as a prop) or a direct
 * `useMotionPreference()` call. Word boundaries keep `systemLowMotion` and
 * `manualLowMotion` from satisfying the check: neither is the effective value.
 */
function referencesLowMotion(node, sourceCode) {
  return /\b(lowMotion|useMotionPreference)\b/.test(sourceCode.getText(node));
}

/**
 * Resolves an identifier to its single declarator initializer one scope hop,
 * so `transition={morphTransition}` is judged by the ternary it was bound to.
 * Returns the input unchanged when the binding is missing, multi-declarator,
 * or not an expression.
 */
function resolveIdentifier(node, sourceCode) {
  if (node.type !== "Identifier") return node;
  const scope = sourceCode.getScope(node);
  const variable = scope.set.get(node.name) ?? scope.upper?.set.get(node.name);
  const def = variable?.defs?.[0];
  if (def?.type === "Variable" && def.node.init) return def.node.init;
  return node;
}

/**
 * Returns true when an `animate` value is driven by an AnimationControls-style
 * hook that owns the motion preference internally (`useAnimation()` consumed by
 * `useIconLoop`, which stops and resets on low motion). Driver-gated elements
 * skip the `transition` check because the driver never starts a cycle.
 */
function isDriverGatedAnimate(node, sourceCode) {
  const resolved = resolveIdentifier(node, sourceCode);
  return (
    resolved.type === "CallExpression" &&
    resolved.callee.type === "Identifier" &&
    /^(useAnimation|useIconLoop|useAnimationControls)$/.test(resolved.callee.name)
  );
}

/**
 * Returns the tag name of a JSX element for swap comparison — `motion.span` and
 * `span` are different trees (a remount on toggle), while `motion.span` vs
 * `motion.div` differ as well. Non-element branches return null.
 */
function jsxTagName(node) {
  if (node?.type !== "JSXElement") return null;
  const name = node.openingElement.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression" && name.object.type === "JSXIdentifier") {
    return `${name.object.name}.${name.property.name}`;
  }
  return null;
}

/**
 * Returns true when a conditional test mentions the low-motion preference —
 * `lowMotion`, `!lowMotion`, or `useMotionPreference().lowMotion` — so branches
 * that swap element types on toggle can be flagged.
 */
function isLowMotionTest(node, sourceCode) {
  return /\blowMotion\b/.test(sourceCode.getText(node));
}

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
    /**
     * Requires every `motion.*` element to honor the shared low-motion preference.
     *
     * Two failure modes are blocked: (1) animation props that ignore the
     * preference — triggers must be inert or reference `lowMotion`, and
     * `transition` must too whenever a trigger is present because gated exits
     * still animate opacity; (2) conditional JSX that swaps element types on
     * `lowMotion` — remounting on toggle loses state and, when the branches
     * space text differently (e.g. word-split flex gaps vs natural spaces),
     * produces visible flicker. The compliant pattern is one tree with
     * `initial={lowMotion ? false : …}`, opacity-only `exit`, and
     * `transition={{ duration: lowMotion ? 0 : … }}`.
     */
    "require-low-motion-variant": {
      meta: {
        type: "problem",
        messages: {
          ungatedProp:
            "'{{prop}}' on <{{tag}}> animates without honoring the low-motion preference. Gate it on `lowMotion` (e.g. `lowMotion ? false : …` or `lowMotion ? { duration: 0 } : …`).",
          ungatedTransition:
            "'transition' on <{{tag}}> must reference `lowMotion` — gated exits still animate opacity, so the duration needs a `lowMotion ? 0 : …` branch.",
          elementSwap:
            "Swapping <{{a}}> for <{{b}}> on `lowMotion` remounts the subtree on every toggle. Render one `motion.*` tree and gate `initial`/`exit`/`transition` on `lowMotion` instead.",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        const filename = context.filename ?? "";
        if (filename.includes(".test.") || filename.includes("src/test/")) return {};

        /**
         * Returns true when every value in an object literal is compile-time
         * static — literals, static template strings, literal arrays, and
         * unary-minus numbers. A static `animate` target never animates on its
         * own, so it needs no gate; a dynamic one animates through `transition`.
         */
        const isStaticValue = (node) => {
          if (node.type === "Literal") return true;
          if (node.type === "TemplateLiteral") return node.expressions.length === 0;
          if (node.type === "UnaryExpression") return node.argument.type === "Literal";
          if (node.type === "ArrayExpression") {
            return node.elements.every((el) => el && isStaticValue(el));
          }
          return false;
        };
        const isStaticObject = (node) =>
          node.type === "ObjectExpression" &&
          node.properties.every(
            (p) => p.type === "Property" && !p.computed && isStaticValue(p.value),
          );

        /**
         * Returns true when a `lowMotion ? A : B` prop disables animation under
         * low motion — the low-motion branch is inert (`false`/`undefined`).
         * Such props need no gated `transition`; ones whose low-motion branch
         * still animates (e.g. `exit: lowMotion ? { opacity: 0 } : …`) do.
         */
        const lowBranchIsInert = (node) =>
          node.type === "ConditionalExpression" &&
          isLowMotionTest(node.test, sourceCode) &&
          isInertExpression(node.consequent);

        /**
         * Classifies one animation attribute: reports ungated triggers and
         * returns whether the element still animates under low motion, which is
         * what obligates `transition` to carry a `lowMotion ? 0 : …` branch.
         */
        const checkProp = (attr, tag) => {
          const prop = attr.name.name;
          if (attr.value?.type !== "JSXExpressionContainer") {
            // Bare `drag`/`layout` attributes and `animate="variant-label"`
            // string literals are always-on triggers with unverifiable timing.
            context.report({
              node: attr,
              messageId: "ungatedProp",
              data: { prop, tag },
            });
            return true;
          }
          const expr = attr.value.expression;
          const resolved = resolveIdentifier(expr, sourceCode);

          if (prop === "animate") {
            if (isDriverGatedAnimate(expr, sourceCode)) return false;
            if (isStaticObject(resolved)) return false;
            if (referencesLowMotion(resolved, sourceCode)) return false;
            if (resolved.type === "ObjectExpression") return true;
            // Variant labels, spread/computed values, and unknown expressions
            // hide their own timing — the element cannot prove a static variant.
            context.report({
              node: attr,
              messageId: "ungatedProp",
              data: { prop, tag },
            });
            return true;
          }

          if (isInertExpression(resolved)) return false;
          if (!referencesLowMotion(resolved, sourceCode)) {
            context.report({
              node: attr,
              messageId: "ungatedProp",
              data: { prop, tag },
            });
            return true;
          }
          // Gated prop: animates under low motion only when its low-motion
          // branch is not inert (opacity-only exits still fade).
          return !lowBranchIsInert(resolved);
        };

        return {
          JSXOpeningElement(node) {
            const name = node.name;
            const tag =
              name.type === "JSXMemberExpression" &&
              name.object.type === "JSXIdentifier" &&
              name.object.name === "motion"
                ? `motion.${name.property.name}`
                : null;
            if (!tag) return;

            let animatesUnderLowMotion = false;
            let transitionAttr = null;
            for (const attr of node.attributes) {
              if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") continue;
              const prop = attr.name.name;
              if (prop === "transition") {
                transitionAttr = attr;
                continue;
              }
              if (prop === "animate" || motionTriggerProps.has(prop)) {
                if (checkProp(attr, tag)) animatesUnderLowMotion = true;
              }
            }
            if (transitionAttr && animatesUnderLowMotion) {
              const expr = transitionAttr.value?.expression;
              if (expr) {
                const resolved = resolveIdentifier(expr, sourceCode);
                if (!referencesLowMotion(resolved, sourceCode)) {
                  context.report({
                    node: transitionAttr,
                    messageId: "ungatedTransition",
                    data: { tag },
                  });
                }
              }
            }
          },

          /**
           * Flags `lowMotion ? <A/> : <B/>` and `lowMotion && <A/>` inside JSX:
           * both remount on toggle. Same-tag branches are allowed — swapping
           * `motion.span` for `motion.span` keeps the tree stable.
           */
          "JSXExpressionContainer > ConditionalExpression"(node) {
            if (!isLowMotionTest(node.test, sourceCode)) return;
            const a = jsxTagName(node.consequent);
            const b = jsxTagName(node.alternate);
            if (a && b && a !== b) {
              context.report({
                node,
                messageId: "elementSwap",
                data: { a, b },
              });
            }
          },
          "JSXExpressionContainer > LogicalExpression[operator='&&']"(node) {
            if (!isLowMotionTest(node.left, sourceCode)) return;
            if (jsxTagName(node.right)) {
              context.report({
                node,
                messageId: "elementSwap",
                data: { a: jsxTagName(node.right), b: "nothing" },
              });
            }
          },
        };
      },
    },
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
