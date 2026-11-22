/**
 * Validates that a value is a non-null, non-array object record.
 *
 * @param {unknown} value - Value to test
 * @param {string} name - Contextual label for error reporting
 * @returns {Record<string, any>} The validated object
 * @throws {TypeError} If value is null, an array, or not an object
 */
export function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Asserts that an object contains only keys from an expected set, and by default
 * requires every expected key to be present. Pass `{ allowMissing: true }` when
 * fields are optional and only unknown keys should be rejected.
 *
 * @param {Record<string, unknown>} value - Object to inspect
 * @param {Set<string>} expected - Set of allowed (and unless allowMissing, required) key names
 * @param {string} name - Contextual label for error reporting
 * @param {{ allowMissing?: boolean }} [options={}] - Key-completeness options
 * @returns {void}
 * @throws {TypeError} If any unknown keys (or missing keys when required) are detected
 */
export function exactKeys(value, expected, name, { allowMissing = false } = {}) {
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${name} contains unknown fields: ${unknown.join(", ")}`);
  }
  if (!allowMissing) {
    const missing = [...expected].filter((key) => !(key in value));
    if (missing.length > 0) {
      throw new TypeError(`${name} is missing fields: ${missing.join(", ")}`);
    }
  }
}

/**
 * Validates that a value is a string matching a regular expression pattern.
 *
 * @param {unknown} value - Value to validate
 * @param {RegExp} pattern - Regular expression the string must satisfy
 * @param {string} name - Contextual label for error reporting
 * @returns {string} The validated string value
 * @throws {TypeError} If value is not a string or fails pattern matching
 */
export function matchedString(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}
