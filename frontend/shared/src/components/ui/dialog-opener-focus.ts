import * as React from "react";

type FocusEventHandler = (event: Event) => void;

export function useDialogOpenerFocus(
  onOpenAutoFocus?: FocusEventHandler,
  onCloseAutoFocus?: FocusEventHandler,
): { onOpenAutoFocus: FocusEventHandler; onCloseAutoFocus: FocusEventHandler } {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const handleOpenAutoFocus = React.useCallback<FocusEventHandler>(
    (event) => {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(event);
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
