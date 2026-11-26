import {
  CANONICAL_COMPONENT_STEMS,
  CANONICAL_FLAT_OWNERS,
  SANCTIONED_APP_COMPONENTS,
  normalizePath,
  normalizeStem,
  stemOf,
} from "./ui-contract-lib.mjs";

const appComponentPathPattern = /\/frontend\/app\/src\/components\/(ui|atoms|primitives)\//;
const sharedComponentPathPattern = /\/frontend\/shared\/src\/components\/(ui|atoms|primitives)\//;

const colorUtilityFamilies =
  "bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|fill|stroke|from|via|to|shadow|inset-shadow|drop-shadow|caret|accent|decoration|divide|outline";

const rawPaletteHues =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";

const providerColorLeakPattern = new RegExp(`(?:^|[\\s:])(?:${colorUtilityFamilies})-platform-`);
const rawPaletteUtilityPattern = new RegExp(
  `(?:^|[\\s:])(?:${colorUtilityFamilies})-(?:black|white|(?:${rawPaletteHues})-\\d{2,3})(?:\\/|\\s|!|$)`,
);

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
            const retired = filename.match(appComponentPathPattern);
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
              const flat = filename.match(sharedComponentPathPattern);
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
