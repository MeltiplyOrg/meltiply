export function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

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

export function matchedString(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}
