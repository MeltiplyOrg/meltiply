// Shared JSONC parsing for repository scripts. Wrangler configs and other
// checked-in JSONC files must be parsed through here so there is exactly one
// comment/trailing-comma stripping implementation (AUD-028).
//
// The parser is string-aware: comments inside string literals are preserved,
// and trailing commas before `}`/`]` are removed outside strings.

/**
 * Strips single-line (//) and multi-line block comments from a JSONC string.
 * String-aware scanner that preserves comment-like characters inside JSON string
 * literals, handles backslash escapes, preserves newlines for error attribution,
 * and fails closed on unterminated comments or strings (AUD-028).
 *
 * @param {string} source - Raw JSONC string content to strip
 * @returns {string} JSON string with comments removed and line counts preserved
 * @throws {TypeError} If the source contains an unterminated comment or string
 */
function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index += 1;
      }
      if (index >= source.length) throw new TypeError("unterminated JSONC comment");
      index += 1;
      continue;
    }
    result += current;
  }
  if (inString) throw new TypeError("unterminated JSONC string");
  return result;
}

/**
 * Strips trailing commas immediately preceding closing braces ('}') or brackets (']')
 * in JSON structures outside of string literals.
 * Ensures compatibility with standard JSON.parse for JSONC files like Wrangler configs.
 *
 * @param {string} source - JSON string (typically after comment stripping)
 * @returns {string} Valid JSON string without trailing commas
 */
function stripTrailingCommas(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += current;
  }
  return result;
}

/**
 * Parses a JSONC (JSON with Comments) string into a JavaScript object or value.
 * Serves as the repository-wide shared parser for Wrangler configurations and tooling,
 * stripping byte-order marks (BOM), comments, and trailing commas while maintaining
 * strict failure reporting on malformed input (AUD-028).
 *
 * @param {string} source - JSONC input text to parse
 * @param {string} [name="JSONC input"] - Contextual label for error reporting
 * @returns {any} Parsed JSON data
 * @throws {TypeError} If the JSONC input is malformed or invalid JSON
 */
export function parseJsonc(source, name = "JSONC input") {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(source.replace(/^\uFEFF/, ""))));
  } catch (error) {
    throw new TypeError(`${name} is invalid: ${error.message}`);
  }
}
