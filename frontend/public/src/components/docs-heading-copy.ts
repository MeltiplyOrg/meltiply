import { copyText } from "@meltiply/ui/copy-text";
import { toast } from "@meltiply/ui/toast";

/**
 * Gives statically rendered heading buttons native click/keyboard activation
 * before React hydration and after every guide swap. Copies the current page
 * URL with the clicked heading's hash, preserving query parameters. Successful
 * writes show the shared app-style success toast with the exact copied URL and
 * retain the inline 1.5s confirmation. Failure shows an error toast plus selected
 * manual-copy recovery; navigation removes recovery, not the persistent toaster.
 */
export function initializeHeadingCopying(): void {
  const resets = new WeakMap<HTMLButtonElement, number>();
  let recovery: {
    panel: HTMLElement;
    button: HTMLButtonElement;
  } | null = null;

  /** Removes recovery UI and resets its error state; dismissal restores focus if it was inside the panel. */
  const clearRecovery = (restoreFocus = false) => {
    if (!recovery) return;
    const { panel, button } = recovery;
    const hadFocus = panel.contains(document.activeElement);
    panel.remove();
    recovery = null;
    if (button.dataset.docsCopyState === "error") {
      delete button.dataset.docsCopyState;
      button.removeAttribute("title");
      const label = button.querySelector<HTMLElement>(".sr-only");
      if (label) label.textContent = "Copy Anchor Link";
    }
    if (restoreFocus && hadFocus && button.isConnected) button.focus({ preventScroll: true });
  };

  /**
   * Shows clipboard-denial recovery beside the affected heading without a modal.
   * The read-only URL is focused/selected for native copying; retry uses the same
   * heading handler, and dismiss returns keyboard focus to its copy control.
   */
  const showRecovery = (button: HTMLButtonElement, heading: HTMLElement, url: string) => {
    clearRecovery();
    const panel = document.createElement("div");
    panel.className = "docs-copy-recovery not-prose";
    panel.dataset.docsCopyRecovery = "";
    const message = document.createElement("p");
    message.id = `${heading.id}-copy-error`;
    message.setAttribute("role", "status");
    message.textContent = "Couldn’t copy automatically. Select the URL below and copy it manually.";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = url;
    input.setAttribute("aria-label", "Section URL");
    input.setAttribute("aria-describedby", message.id);
    input.addEventListener("focus", () => input.select());
    const actions = document.createElement("div");
    actions.className = "docs-copy-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => button.click());
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => clearRecovery(true));
    actions.append(retry, dismiss);
    panel.append(message, input, actions);
    heading.after(panel);
    recovery = { panel, button };
    input.focus({ preventScroll: true });
    input.select();
  };

  /** Copies marked controls, reports the actual outcome through Sileo, and retains manual recovery when both clipboard methods fail. */
  const onClick = async (event: MouseEvent) => {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-docs-heading] > button")
        : null;
    if (!button || button.dataset.docsCopyState === "copying") return;
    const heading = button.closest<HTMLElement>("[data-docs-heading]");
    if (!heading?.id) return;
    event.preventDefault();
    clearRecovery(true);
    const label = button.querySelector<HTMLElement>(".sr-only");
    clearTimeout(resets.get(button));
    button.dataset.docsCopyState = "copying";
    button.setAttribute("aria-busy", "true");
    const url = new URL(window.location.href);
    url.hash = heading.id;
    try {
      await copyText(url.href);
      if (!button.isConnected) return;
      button.dataset.docsCopyState = "copied";
      button.title = "Copied Anchor Link";
      if (label) label.textContent = "Copied Anchor Link";
      toast("Section link copied", {
        description: `Copied “${url.href}” to your clipboard.`,
        variant: "success",
      });
      resets.set(
        button,
        window.setTimeout(() => {
          if (!button.isConnected) return;
          delete button.dataset.docsCopyState;
          button.removeAttribute("title");
          if (label) label.textContent = "Copy Anchor Link";
          resets.delete(button);
        }, 1500),
      );
    } catch {
      if (!button.isConnected) return;
      button.dataset.docsCopyState = "error";
      button.title = "Couldn’t copy automatically";
      if (label) label.textContent = "Copy failed. Try again.";
      toast("Could not copy section link", {
        description: "Select the section URL below and copy it manually.",
        variant: "error",
      });
      showRecovery(button, heading, url.href);
    } finally {
      button.removeAttribute("aria-busy");
    }
  };

  document.addEventListener("click", (event) => {
    void onClick(event);
  });
  document.addEventListener("astro:before-preparation", () => clearRecovery());
  document.addEventListener("astro:before-swap", () => clearRecovery());
}
