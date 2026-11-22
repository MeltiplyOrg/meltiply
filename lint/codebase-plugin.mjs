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
const vendoredPattern = /\/frontend\/app\/src\/components\/evilcharts\//;

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
  return rule(message, (context, report) => ({
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        if (matches(comment, context)) report({ loc: comment.loc });
      }
    },
  }));
}

function isToolDirective(comment) {
  return toolDirectivePattern.test(comment.value);
}

function isLicenseHeader(comment) {
  return /@license|SPDX-License-Identifier|Copyright \(c\)/i.test(comment.value);
}

function isExportDocComment(comment, context) {
  const token = context.sourceCode.getTokenAfter(comment, { includeComments: false });
  return token?.type === "Keyword" && token.value === "export";
}

const codebasePlugin = {
  meta: { name: "meltiply" },
  rules: {
    "no-unknown-double-cast": rule(
      "Do not cast through `unknown`. Build a typed value (typed test builder, schema decode, or a narrow port type) instead.",
      (_context, report) => ({
        TSAsExpression(node) {
          const inner = node.expression;
          if (
            inner?.type === "TSAsExpression" &&
            inner.typeAnnotation?.type === "TSUnknownKeyword"
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
        if (filenameOf(context).endsWith("packages/domain/src/index.ts")) return {};
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
        if (vendoredPattern.test(filename)) return false;
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
