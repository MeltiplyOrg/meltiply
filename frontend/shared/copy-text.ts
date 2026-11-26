type ClipboardWriter = Pick<Clipboard, "writeText">;

function legacyCopy(text: string, documentObject: Document): boolean {
  const activeElement = documentObject.activeElement;
  const textarea = documentObject.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    width: "2em",
    height: "2em",
    padding: "0",
    border: "none",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
  });
  documentObject.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // iOS Safari ignores select() on a textarea; an explicit range is required.
    textarea.setSelectionRange(0, text.length);
    return documentObject.execCommand("copy");
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
  }
}

export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
  documentObject: Document = document,
): Promise<void> {
  if (documentObject.defaultView?.isSecureContext !== false && clipboard) {
    const written = await clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (written) return;
  }
  if (!legacyCopy(text, documentObject)) {
    throw new Error("The browser did not grant clipboard access.");
  }
}
