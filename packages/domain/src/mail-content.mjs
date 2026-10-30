const senderAddressPattern =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const unsafeDisplayNamePunctuation = '",:;<>\\';
/** @type {Readonly<Record<string, string>>} */
const htmlEscapes = {
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * Checks a normalized bare sender address against the shared dot-atom/DNS policy.
 * Empty local-part atoms, header syntax, and values over 254 characters fail.
 * Local single-label domains are allowed unless release validation requires a dot.
 * @param {string} value - Address without surrounding whitespace or display name.
 * @param {boolean} [requireDottedDomain=false] - Require multiple DNS labels.
 * @returns {boolean} Whether the address satisfies the sender policy.
 */
export function isMailSenderAddress(value, requireDottedDomain = false) {
  return (
    value.length <= 254 &&
    senderAddressPattern.test(value) &&
    (!requireDottedDomain || value.indexOf(".", value.indexOf("@") + 1) !== -1)
  );
}

/**
 * Checks a normalized sender name without allocating a character array.
 * Names over 200 characters, ASCII controls, DEL, and header punctuation fail;
 * callers decide whether blank names are omitted or rejected.
 * @param {string} value - Display name after the caller's normalization policy.
 * @returns {boolean} Whether the name is safe as an unquoted display name.
 */
export function isMailSenderName(value) {
  if (value.length > 200) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      unsafeDisplayNamePunctuation.includes(character)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves the configured sender identity for both Worker mail paths.
 *
 * `MAIL_FROM_ADDRESS` must be a bare dot-atom address; malformed values yield
 * undefined so delivery fails closed as unavailable rather than dispatching an
 * invalid sender. `MAIL_FROM_NAME` is optional; a nonblank unsafe name also
 * fails closed instead of silently dropping it, and a blank name is omitted.
 * @param {{ MAIL_FROM_ADDRESS?: string, MAIL_FROM_NAME?: string }} env - Worker variables.
 * @returns {{ email: string, name?: string } | undefined} The validated sender, or undefined.
 */
export function mailSenderConfiguration(env) {
  const email = env.MAIL_FROM_ADDRESS?.trim();
  if (email === undefined || !isMailSenderAddress(email)) {
    return undefined;
  }
  const name = env.MAIL_FROM_NAME?.trim();
  if (name !== undefined && name.length > 0) {
    if (!isMailSenderName(name)) {
      return undefined;
    }
    return { email, name };
  }
  return { email };
}

/**
 * Escapes raw mail-template text once for HTML content and quoted attributes.
 * Replaces &, <, >, and both quotes in one pass; existing entities are raw input
 * too, so `&amp;` becomes `&amp;amp;`. Plain-text bodies must stay unescaped.
 * @param {string} value - Raw text, not already HTML-escaped content.
 * @returns {string} Text safe to interpolate into HTML mail templates.
 */
export function escapeMailHtml(value) {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character] ?? character);
}
