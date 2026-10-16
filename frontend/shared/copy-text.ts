type ClipboardWriter = Pick<Clipboard, "writeText">;

/**
 * Copies text to the clipboard using an off-screen `<textarea>` and `document.execCommand("copy")`.
 * Used as a fallback on insecure origins (such as plain-HTTP Tailscale addresses) or when
 * the asynchronous Clipboard API is restricted. Ensures the textarea is positioned off-screen,
 * focused, selected, and executed synchronously within the user activation window.
 *
 * @param text Content string to copy into the system clipboard.
 * @param documentObject The target DOM document hosting the temporary textarea.
 * @returns `true` if the browser executed the copy command successfully, `false` otherwise.
 */
function legacyCopy(text: string, documentObject: Document): boolean {
  const activeElement = documentObject.activeElement;
  const textarea = documentObject.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.width = "2em";
  textarea.style.height = "2em";
  textarea.style.padding = "0";
  textarea.style.border = "none";
  textarea.style.outline = "none";
  textarea.style.boxShadow = "none";
  textarea.style.background = "transparent";
  textarea.setAttribute("aria-hidden", "true");

  documentObject.body.append(textarea);

  try {
    if (typeof textarea.focus === "function") {
      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }
    }
    textarea.select();
    if (typeof textarea.setSelectionRange === "function") {
      textarea.setSelectionRange(0, textarea.value.length);
    }

    return documentObject.execCommand("copy");
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement && typeof activeElement.focus === "function") {
      try {
        activeElement.focus({ preventScroll: true });
      } catch {
        activeElement.focus();
      }
    }
  }
}

/**
 * Copies plain text to the user's clipboard. Prefers `navigator.clipboard.writeText`
 * in secure contexts, but bypasses it immediately on insecure origins (such as plain-HTTP
 * Tailscale addresses) to run `legacyCopy` synchronously within the user gesture window
 * before transient user activation expires.
 *
 * @param text The text string to place on the clipboard.
 * @param clipboard Optional clipboard writer interface, defaulting to `navigator.clipboard`.
 * @param documentObject Optional Document instance, defaulting to global `document`.
 * @throws {Error} When both modern clipboard writes and legacy selection copy fail.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
  documentObject: Document = document,
): Promise<void> {
  const isExplicitlyInsecure = documentObject.defaultView?.isSecureContext === false;

  if (!isExplicitlyInsecure && clipboard) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Modern write rejected in secure context, fall through to legacy copy.
    }
  }

  if (!legacyCopy(text, documentObject)) {
    throw new Error("The browser did not grant clipboard access.");
  }
}
