import * as React from "react";

/** Radix's content focus hooks receive one plain event it may prevent. */
type FocusEventHandler = (event: Event) => void;

/**
 * Captures the control that opened a controlled centered dialog and returns
 * focus to it when the exit finishes.
 *
 * Radix's modal content restores focus only to a `DialogTrigger` ref. Every
 * Meltiply centered dialog is opened from controlled state (a row action, a
 * menu item, or a toolbar button), so without this hook the primitive prevents
 * its own unmount fallback and clears focus to the body. The opener is captured
 * during Radix's open-autofocus event, before the initial field takes focus, and
 * a still-connected opener is focused without scrolling the surface underneath.
 * When the call site does use a trigger, that trigger is the captured element,
 * so behavior is identical.
 *
 * Caller handlers run first: an open handler's `preventDefault` still suppresses
 * the primitive's initial focus, and a close handler that already prevented the
 * event keeps ownership of focus.
 *
 * @param onOpenAutoFocus - Caller's Radix open-autofocus handler.
 * @param onCloseAutoFocus - Caller's Radix close-autofocus handler.
 * @returns Handlers for the Radix content element.
 */
export function useDialogOpenerFocus(
  onOpenAutoFocus?: FocusEventHandler,
  onCloseAutoFocus?: FocusEventHandler,
): { onOpenAutoFocus: FocusEventHandler; onCloseAutoFocus: FocusEventHandler } {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const handleOpenAutoFocus = React.useCallback<FocusEventHandler>(
    (event) => {
      onOpenAutoFocus?.(event);
      const active = document.activeElement;
      // A body focus means the owner opened the dialog programmatically; leave
      // focus restoration to the primitive's own trigger when one exists.
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    [onOpenAutoFocus],
  );

  const handleCloseAutoFocus = React.useCallback<FocusEventHandler>(
    (event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const opener = openerRef.current;
      openerRef.current = null;
      if (!opener?.isConnected) return;
      event.preventDefault();
      opener.focus({ preventScroll: true });
    },
    [onCloseAutoFocus],
  );

  return { onOpenAutoFocus: handleOpenAutoFocus, onCloseAutoFocus: handleCloseAutoFocus };
}
