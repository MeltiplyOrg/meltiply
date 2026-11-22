/**
 * Codebase-wide `meltiply/*` lint rules that encode mistake classes this
 * repository has already fixed once, so they cannot return silently.
 *
 * Loaded as an Oxlint JS plugin (`lint.jsPlugins` in the root vite.config.ts).
 * Rules are syntactic: JS plugins cannot use type information.
 */

const PLATFORM_IDS = new Set(["tiktok", "youtube", "instagram", "facebook", "threads"]);
const auditReferencePattern = /\bAUD-\d+\b|\bissue #\d+\b|\bpre-migration\b/i;
const messageClassifierMethods = new Set(["includes", "startsWith", "endsWith", "match", "test"]);

/** True when `node` reads `<something>.message` or a local named `message`, optionally through `.toLowerCase()`/`.toUpperCase()`/`.trim()`. */
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

/** True for a string literal naming a supported Platform. */
function isPlatformLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string" && PLATFORM_IDS.has(node.value);
}

/** True for `x.query(...)`, `client.query(...)`, or a bare `query(...)` call. */
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

/** True when `expression` contains a conditional or logical expression anywhere in its tree. */
function containsBranch(expression) {
  if (!expression || typeof expression !== "object") return false;
  if (expression.type === "ConditionalExpression" || expression.type === "LogicalExpression") {
    return true;
  }
  if (expression.type === "TemplateLiteral") return expression.expressions.some(containsBranch);
  return false;
}

/** Normalizes a filename to forward slashes for path matching. */
function normalizedFilename(context) {
  return String(context.filename ?? "").replaceAll("\\", "/");
}

const codebasePlugin = {
  meta: { name: "meltiply" },
  rules: {
    /**
     * Bans `value as unknown as T`. A double assertion discards every type
     * check between two unrelated shapes; build a typed value (a test
     * builder, a schema decode, or a narrow port type) instead.
     */
    "no-unknown-double-cast": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Do not cast through `unknown`. Build a typed value (typed test builder, schema decode, or a narrow port type) instead.",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            const inner = node.expression;
            if (
              inner?.type === "TSAsExpression" &&
              inner.typeAnnotation?.type === "TSUnknownKeyword"
            ) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Bans classifying errors by substring-matching their message text.
     * Message wording is not a contract; a rewording silently reclassifies a
     * failure. Branch on an error class, `_tag`, or a typed error code.
     */
    "no-error-message-classification": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Do not classify errors by message text. Branch on an error class, `_tag`, or a typed error code.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              callee.computed ||
              !messageClassifierMethods.has(callee.property?.name)
            ) {
              return;
            }
            if (callee.property.name === "test") {
              if (node.arguments.some((argument) => readsErrorMessage(argument))) {
                context.report({ node, messageId: "restricted" });
              }
              return;
            }
            if (readsErrorMessage(callee.object)) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Requires the shared `errorMessage(cause, fallback)` helper from
     * `@meltiply/domain` instead of re-implementing
     * `cause instanceof Error ? cause.message : fallback` at each boundary.
     */
    "prefer-error-message-helper": {
      meta: {
        type: "suggestion",
        messages: {
          restricted:
            "Use errorMessage(cause, fallback) from @meltiply/domain instead of an inline `instanceof Error ? .message :` ternary.",
        },
      },
      create(context) {
        return {
          ConditionalExpression(node) {
            const test = node.test;
            if (
              test?.type === "BinaryExpression" &&
              test.operator === "instanceof" &&
              test.right?.type === "Identifier" &&
              test.right.name === "Error" &&
              readsErrorMessage(node.consequent)
            ) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Bans re-declaring the Platform roster. `PLATFORM_IDS` in
     * `@meltiply/domain` is the single source; a copied list silently misses a
     * newly supported Platform.
     */
    "no-platform-roster-literal": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Do not re-declare the Platform roster. Import PLATFORM_IDS from @meltiply/domain (or derive from it).",
        },
      },
      create(context) {
        if (normalizedFilename(context).endsWith("packages/domain/src/index.ts")) return {};
        return {
          ArrayExpression(node) {
            const platforms = node.elements.filter(isPlatformLiteral);
            if (platforms.length >= 3) context.report({ node, messageId: "restricted" });
          },
        };
      },
    },

    /**
     * Bans building SQL text with a conditional fragment inside a `query()`
     * template. Branching SQL text licenses injection the day a branch takes
     * a value; select between complete literal statements instead.
     */
    "no-sql-conditional-fragment": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Do not branch inside SQL template text. Select between two complete literal statements, and pass data as $n parameters.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isQueryCall(node)) return;
            const text = node.arguments[0];
            if (text?.type === "TemplateLiteral" && text.expressions.some(containsBranch)) {
              context.report({ node: text, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Bans `[...text].length`, which allocates one array element per code
     * point just to count them. Use the shared zero-allocation
     * `codePointLength(text)` from @meltiply/domain.
     */
    "no-codepoint-spread-length": {
      meta: {
        type: "suggestion",
        messages: {
          restricted:
            "Use codePointLength(text) from @meltiply/domain instead of allocating `[...text].length`.",
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (
              !node.computed &&
              node.property?.type === "Identifier" &&
              node.property.name === "length" &&
              node.object?.type === "ArrayExpression" &&
              node.object.elements.length === 1 &&
              node.object.elements[0]?.type === "SpreadElement"
            ) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Bans `JSON.parse(raw) as T` for any `T` other than `unknown`. Parsed JSON
     * is untrusted until a schema or guard narrows it.
     */
    "no-json-parse-cast": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Parsed JSON is untrusted. Assign it as `unknown` and narrow with a schema or type guard instead of asserting a type.",
        },
      },
      create(context) {
        return {
          TSAsExpression(node) {
            const parsed = node.expression;
            if (
              parsed?.type === "CallExpression" &&
              parsed.callee.type === "MemberExpression" &&
              parsed.callee.object?.type === "Identifier" &&
              parsed.callee.object.name === "JSON" &&
              parsed.callee.property?.name === "parse" &&
              node.typeAnnotation?.type !== "TSUnknownKeyword"
            ) {
              context.report({ node, messageId: "restricted" });
            }
          },
        };
      },
    },

    /**
     * Bans React keys derived from the clock. `Date.now()` collides within a
     * millisecond and changes identity on every render path that rebuilds it.
     */
    "no-time-derived-key": {
      meta: {
        type: "problem",
        messages: {
          restricted:
            "Do not derive identities from Date.now(). Use crypto.randomUUID() or a stable domain id.",
        },
      },
      create(context) {
        return {
          TemplateLiteral(node) {
            const usesClock = node.expressions.some(
              (expression) =>
                expression.type === "CallExpression" &&
                expression.callee.type === "MemberExpression" &&
                expression.callee.object?.type === "Identifier" &&
                expression.callee.object.name === "Date" &&
                expression.callee.property?.name === "now",
            );
            if (!usesClock) return;
            const parent = node.parent;
            const isKeyAttribute =
              parent?.type === "JSXExpressionContainer" &&
              parent.parent?.type === "JSXAttribute" &&
              parent.parent.name?.name === "key";
            const isKeyProperty =
              parent?.type === "Property" &&
              parent.key?.type === "Identifier" &&
              parent.key.name === "key";
            if (isKeyAttribute || isKeyProperty) context.report({ node, messageId: "restricted" });
          },
        };
      },
    },

    /**
     * Bans comments that cite audit IDs, issue numbers, or migration history.
     * Comments state current contracts; history belongs in Git.
     */
    "no-history-comments": {
      meta: {
        type: "suggestion",
        messages: {
          restricted:
            "Comments state current behavior. Remove audit IDs, issue numbers, and migration history; Git records history.",
        },
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (auditReferencePattern.test(comment.value)) {
                context.report({ loc: comment.loc, messageId: "restricted" });
              }
            }
          },
        };
      },
    },
  },
};

export default codebasePlugin;
