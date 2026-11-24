const PLATFORM_IDS = new Set(["tiktok", "youtube", "instagram", "facebook", "threads"]);
const historyReferencePattern = /\bAUD-\d+\b|\bissue #\d+\b|\(#\d+\)|\bpre-migration\b/i;
const jsdocTagPattern = /^\s*\*?\s*@(param|returns?|throws|type|typedef|template)\b/m;
const bannerPattern = /^[\s*/=\-#~_─━═]{6,}$|^[\s]*[=\-─━═]{4,}.*[=\-─━═]{4,}\s*$/;
const commentedCodePattern =
  /^\s*(?:(?:const|let|var|import|export|return|await|throw)\s.*[;{)]|(?:if|for|while)\s*\(.*\)\s*\{?|[\w.]+\(.*\);)\s*$/;
const toolDirectivePattern =
  /^\s*(?:prettier-ignore|eslint-|oxlint-|@ts-|istanbul|c8|v8|vite-ignore|webpackChunkName|@vite-ignore|#__PURE__|@__PURE__|global\s)/;
const messageClassifierMethods = new Set(["includes", "startsWith", "endsWith", "match", "test"]);
const docCommentAllowedPattern = /\/packages\/[^/]+\/src\//;
const generatedPattern = /\/generated\//;
const vendoredPattern = /\/frontend\/app\/src\/components\/evilcharts\//;
const sqlDateColumnPattern = /::date\s+AS\s/i;
const sessionAdvisoryLockPattern = /\bpg_(?:try_)?advisory_lock\s*\(/i;
const workerEffectRunAllowed = [
  "/workers/automation/src/effect/boundary.ts",
  "/workers/state/src/index.ts",
];
const workerEffectRunScoped = /\/workers\/(?:automation|state)\/src\//;

function readsErrorMessage(node) {
  if (node?.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const name = node.callee.property?.name;
    if (name === "toLowerCase" || name === "toUpperCase" || name === "trim") {
      return readsErrorMessage(node.callee.object);
    }
  }
  if (node?.type === "Identifier") return node.name === "message";
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === "message"
  );
}

function isPlatformLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string" && PLATFORM_IDS.has(node.value);
}

function isQueryCall(node) {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === "query";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    callee.property.name === "query"
  );
}

function containsBranch(expression) {
  if (!expression || typeof expression !== "object") return false;
  if (expression.type === "ConditionalExpression" || expression.type === "LogicalExpression") {
    return true;
  }
  if (expression.type === "TemplateLiteral") return expression.expressions.some(containsBranch);
  return false;
}

function isMemberCall(node, objectName, propertyName) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === objectName &&
    node.callee.property?.name === propertyName
  );
}

function filenameOf(context) {
  return String(context.filename ?? "").replaceAll("\\", "/");
}

function rule(message, create) {
  return {
    meta: { type: "problem", messages: { restricted: message } },
    create(context) {
      return create(context, (target) =>
        context.report(
          target.loc && !target.type
            ? { loc: target.loc, messageId: "restricted" }
            : { node: target, messageId: "restricted" },
        ),
      );
    },
  };
}

function commentRule(message, matches) {
  return rule(message, (context, report) => {
    if (vendoredPattern.test(filenameOf(context))) return {};
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (matches(comment, context)) report({ loc: comment.loc });
        }
      },
    };
  });
}

function isToolDirective(comment) {
  return toolDirectivePattern.test(comment.value);
}

function isLicenseHeader(comment) {
  return /@license|SPDX-License-Identifier|Copyright \(c\)/i.test(comment.value);
}

function isExportedContractDeclaration(node) {
  let current = node;
  while (current) {
    if (current.type === "ExportNamedDeclaration" || current.type === "ExportDefaultDeclaration") {
      return true;
    }
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression" ||
      current.type === "BlockStatement"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isExportDocComment(comment, context) {
  const token = context.sourceCode.getTokenAfter(comment, { includeComments: false });
  if (!token) return false;
  if (token.type === "Keyword" && token.value === "export") return true;
  const node = context.sourceCode.getNodeByRangeIndex?.(token.range[0]);
  return node ? isExportedContractDeclaration(node) : false;
}

const codebasePlugin = {
  meta: { name: "meltiply" },
  rules: {
    "no-chained-type-assertions": rule(
      "Do not chain type assertions. Preserve the original type, build a typed value, or validate untrusted input at its boundary.",
      (_context, report) => {
        const isAssertion = (node) =>
          node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
        const check = (node) => {
          let parent = node.parent;
          while (parent?.type === "ParenthesizedExpression") parent = parent.parent;
          if (isAssertion(parent)) return;
          let current = node;
          let count = 0;
          let hasNonConstAssertion = false;
          while (isAssertion(current)) {
            count += 1;
            const annotation = current.typeAnnotation;
            hasNonConstAssertion ||=
              annotation?.type !== "TSTypeReference" || annotation.typeName?.name !== "const";
            current = current.expression;
            while (current?.type === "ParenthesizedExpression") current = current.expression;
          }
          if (count > 1 && hasNonConstAssertion) report(node);
        };
        return { TSAsExpression: check, TSTypeAssertion: check };
      },
    ),

    "no-promise-sleep": rule(
      "Do not synchronize cache tests with timer Promises. Await a completion signal or advance the controlled clock.",
      (_context, report) => ({
        NewExpression(node) {
          if (node.callee.type !== "Identifier" || node.callee.name !== "Promise") return;
          const executor = node.arguments[0];
          if (
            executor?.type !== "ArrowFunctionExpression" &&
            executor?.type !== "FunctionExpression"
          )
            return;
          const resolve = executor.params[0];
          if (resolve?.type !== "Identifier") return;
          let body = executor.body;
          if (body.type === "BlockStatement") {
            if (body.body.length !== 1) return;
            const statement = body.body[0];
            body = statement.type === "ReturnStatement" ? statement.argument : statement.expression;
          }
          if (body?.type !== "CallExpression") return;
          const callee = body.callee;
          const isTimer =
            (callee.type === "Identifier" && callee.name === "setTimeout") ||
            (callee.type === "MemberExpression" &&
              !callee.computed &&
              ["globalThis", "window"].includes(callee.object?.name) &&
              callee.property?.name === "setTimeout");
          if (
            isTimer &&
            body.arguments[0]?.type === "Identifier" &&
            body.arguments[0].name === resolve.name
          ) {
            report(node);
          }
        },
      }),
    ),

    "no-error-message-classification": rule(
      "Do not classify errors by message text. Branch on an error class, `_tag`, or a typed error code.",
      (_context, report) => ({
        CallExpression(node) {
          const callee = node.callee;
          if (
            callee.type !== "MemberExpression" ||
            callee.computed ||
            !messageClassifierMethods.has(callee.property?.name)
          ) {
            return;
          }
          const classifies =
            callee.property.name === "test"
              ? node.arguments.some((argument) => readsErrorMessage(argument))
              : readsErrorMessage(callee.object);
          if (classifies) report(node);
        },
      }),
    ),

    "prefer-error-message-helper": rule(
      "Use errorMessage(cause, fallback) from @meltiply/domain instead of an inline `instanceof Error ? .message :` ternary.",
      (_context, report) => ({
        ConditionalExpression(node) {
          const test = node.test;
          if (
            test?.type === "BinaryExpression" &&
            test.operator === "instanceof" &&
            test.right?.type === "Identifier" &&
            test.right.name === "Error" &&
            readsErrorMessage(node.consequent)
          ) {
            report(node);
          }
        },
      }),
    ),

    "no-platform-roster-literal": rule(
      "Do not re-declare the Platform roster. Import PLATFORM_IDS from @meltiply/domain (or derive from it).",
      (context, report) => {
        const filename = filenameOf(context);
        if (
          !/\.[cm]?tsx?$/.test(filename) ||
          filename.endsWith("packages/domain/src/index.ts") ||
          filename.endsWith("packages/domain/test/index.test.ts") ||
          filename.endsWith("lint/codebase-plugin.mjs")
        ) {
          return {};
        }
        return {
          ArrayExpression(node) {
            if (node.elements.filter(isPlatformLiteral).length >= 3) report(node);
          },
        };
      },
    ),

    "no-sql-conditional-fragment": rule(
      "Do not branch inside SQL template text. Select between two complete literal statements, and pass data as $n parameters.",
      (_context, report) => ({
        CallExpression(node) {
          if (!isQueryCall(node)) return;
          const text = node.arguments[0];
          if (text?.type === "TemplateLiteral" && text.expressions.some(containsBranch)) {
            report(text);
          }
        },
      }),
    ),

    "no-codepoint-spread-length": rule(
      "Use codePointLength(text) from @meltiply/domain instead of allocating `[...text].length`.",
      (_context, report) => ({
        MemberExpression(node) {
          if (
            !node.computed &&
            node.property?.type === "Identifier" &&
            node.property.name === "length" &&
            node.object?.type === "ArrayExpression" &&
            node.object.elements.length === 1 &&
            node.object.elements[0]?.type === "SpreadElement"
          ) {
            report(node);
          }
        },
      }),
    ),

    "no-json-parse-cast": rule(
      "Parsed JSON is untrusted. Assign it as `unknown` and narrow with a schema or type guard instead of asserting a type.",
      (_context, report) => ({
        TSAsExpression(node) {
          if (
            isMemberCall(node.expression, "JSON", "parse") &&
            node.typeAnnotation?.type !== "TSUnknownKeyword"
          ) {
            report(node);
          }
        },
      }),
    ),

    "no-time-derived-key": rule(
      "Do not derive identities from Date.now(). Use crypto.randomUUID() or a stable domain id.",
      (_context, report) => ({
        TemplateLiteral(node) {
          if (!node.expressions.some((expression) => isMemberCall(expression, "Date", "now"))) {
            return;
          }
          const parent = node.parent;
          const isKeyAttribute =
            parent?.type === "JSXExpressionContainer" &&
            parent.parent?.type === "JSXAttribute" &&
            parent.parent.name?.name === "key";
          const isKeyProperty =
            parent?.type === "Property" &&
            parent.key?.type === "Identifier" &&
            parent.key.name === "key";
          if (isKeyAttribute || isKeyProperty) report(node);
        },
      }),
    ),

    "no-export-star": rule(
      "List public exports explicitly. `export *` leaks internals and hides import cycles.",
      (_context, report) => ({
        ExportAllDeclaration(node) {
          report(node);
        },
      }),
    ),

    "no-sql-date-column": rule(
      "Select calendar dates as `::date::text`. node-postgres parses DATE as local midnight, which shifts the day on hosts east of UTC.",
      (_context, report) => ({
        TemplateLiteral(node) {
          if (node.quasis.some((quasi) => sqlDateColumnPattern.test(quasi.value.cooked ?? ""))) {
            report(node);
          }
        },
        Literal(node) {
          if (typeof node.value === "string" && sqlDateColumnPattern.test(node.value)) {
            report(node);
          }
        },
      }),
    ),

    "no-workerd-fs-module-cache": rule(
      "Do not enable fsModuleCache in a workerd test pool. Cache hits are read through the workerd virtual filesystem and fail with ENOENT.",
      (_context, report) => {
        let usesWorkerdPool = false;
        return {
          ImportDeclaration(node) {
            if (node.source.value === "@cloudflare/vitest-plugin") usesWorkerdPool = true;
          },
          Property(node) {
            if (
              usesWorkerdPool &&
              node.key?.type === "Identifier" &&
              node.key.name === "fsModuleCache" &&
              node.value?.type === "Literal" &&
              node.value.value === true
            ) {
              report(node);
            }
          },
        };
      },
    ),

    "no-session-advisory-lock": rule(
      "Use transaction-scoped pg_advisory_xact_lock instead of session-level pg_advisory_lock under Hyperdrive transaction pooling.",
      (_context, report) => ({
        TemplateLiteral(node) {
          if (
            node.quasis.some((quasi) => sessionAdvisoryLockPattern.test(quasi.value.cooked ?? ""))
          ) {
            report(node);
          }
        },
        Literal(node) {
          if (typeof node.value === "string" && sessionAdvisoryLockPattern.test(node.value)) {
            report(node);
          }
        },
      }),
    ),

    "no-throw-in-effect-gen": rule(
      "Do not throw inside Effect.gen. Return `yield* Effect.fail(...)` with a typed error instead of raising an untyped defect.",
      (_context, report) => ({
        ThrowStatement(node) {
          let current = node.parent;
          while (current) {
            if (
              current.type === "FunctionExpression" ||
              current.type === "ArrowFunctionExpression" ||
              current.type === "FunctionDeclaration"
            ) {
              if (
                current.generator &&
                isMemberCall(current.parent, "Effect", "gen") &&
                current.parent.arguments[0] === current
              ) {
                report(node);
              }
              return;
            }
            current = current.parent;
          }
        },
      }),
    ),

    "no-worker-effect-run": rule(
      "Effect.run* in automation/state workers is restricted to approved boundary adapters (effect/boundary.ts or workers/state/src/index.ts).",
      (context, report) => {
        const filename = filenameOf(context);
        if (
          !workerEffectRunScoped.test(filename) ||
          workerEffectRunAllowed.some((allowed) => filename.endsWith(allowed))
        ) {
          return {};
        }
        return {
          MemberExpression(node) {
            if (
              !node.computed &&
              node.object?.type === "Identifier" &&
              node.object.name === "Effect" &&
              node.property?.type === "Identifier" &&
              /^run(Promise|Sync|Fork|PromiseExit|SyncExit)$/.test(node.property.name)
            ) {
              report(node);
            }
          },
        };
      },
    ),

    "no-naive-redirect-prefix": rule(
      "Do not validate same-origin redirects with startsWith('/') && !startsWith('//'). Use URL origin validation (sameOriginPath).",
      (_context, report) => ({
        LogicalExpression(node) {
          if (node.operator !== "&&") return;
          const isStartsWith = (expr, prefix) =>
            expr?.type === "CallExpression" &&
            expr.callee.type === "MemberExpression" &&
            !expr.callee.computed &&
            expr.callee.property?.name === "startsWith" &&
            expr.arguments.length === 1 &&
            expr.arguments[0]?.type === "Literal" &&
            expr.arguments[0].value === prefix;
          const isNegatedDoubleSlash = (expr) =>
            expr?.type === "UnaryExpression" &&
            expr.operator === "!" &&
            isStartsWith(expr.argument, "//");
          if (
            (isStartsWith(node.left, "/") && isNegatedDoubleSlash(node.right)) ||
            (isNegatedDoubleSlash(node.left) && isStartsWith(node.right, "/"))
          ) {
            report(node);
          }
        },
      }),
    ),

    "no-history-comments": commentRule(
      "Comments state current behavior. Remove audit IDs, issue numbers, and migration history; Git records history.",
      (comment) => historyReferencePattern.test(comment.value),
    ),

    "no-jsdoc-type-tags": commentRule(
      "Do not narrate signatures with @param/@returns/@throws/@type tags. Names and types carry the contract.",
      (comment) => comment.type === "Block" && jsdocTagPattern.test(comment.value),
    ),

    "no-doc-comment-outside-package-contract": commentRule(
      "Doc comments belong only on exported packages/* contracts. Rename, extract, or type the code so it needs no prose.",
      (comment, context) => {
        if (comment.type !== "Block" || !comment.value.startsWith("*")) return false;
        if (isLicenseHeader(comment) || isToolDirective(comment)) return false;
        const filename = filenameOf(context);
        if (vendoredPattern.test(filename) || generatedPattern.test(filename)) return false;
        return !(docCommentAllowedPattern.test(filename) && isExportDocComment(comment, context));
      },
    ),

    "no-banner-comments": commentRule(
      "Do not divide files with banner comments. Split the module instead.",
      (comment) => comment.value.split("\n").some((line) => bannerPattern.test(line.trim())),
    ),

    "no-commented-out-code": commentRule(
      "Delete commented-out code. Git keeps history.",
      (comment) =>
        comment.type === "Line" &&
        !isToolDirective(comment) &&
        commentedCodePattern.test(comment.value),
    ),
  },
};

export default codebasePlugin;
