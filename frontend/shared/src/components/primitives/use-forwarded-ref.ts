import { useCallback, useRef, type ForwardedRef, type RefObject } from "react";

function assignRef<T>(ref: ForwardedRef<T>, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

export function useForwardedRef<T>(
  forwarded: ForwardedRef<T>,
): [RefObject<T | null>, (node: T | null) => void] {
  const local = useRef<T | null>(null);
  const setRef = useCallback(
    (node: T | null) => {
      local.current = node;
      assignRef(forwarded, node);
    },
    [forwarded],
  );
  return [local, setRef];
}
