const htmlMetacharactersPattern = /[&<>"']/g;

const senderAddressPattern =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const unsafeDisplayNamePunctuation = '",:;<>\\';
const htmlEscapes = {
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * Bare dot-atom sender address of at most 254 characters; single-label domains pass unless `requireDottedDomain`.
 */
export function isMailSenderAddress(value, requireDottedDomain = false) {
  return (
    value.length <= 254 &&
    senderAddressPattern.test(value) &&
    (!requireDottedDomain || value.indexOf(".", value.indexOf("@") + 1) !== -1)
  );
}

/**
 * Display name of at most 200 characters, safe unquoted in a mail header.
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
 * Configured sender, or undefined (mail unavailable) when the address or a nonblank name is unsafe.
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
 * Escapes raw text for HTML mail content and quoted attributes; existing entities are escaped again.
 */
export function escapeMailHtml(value) {
  return value.replace(
    htmlMetacharactersPattern,
    (character) => htmlEscapes[character] ?? character,
  );
}
