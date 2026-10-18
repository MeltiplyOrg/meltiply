import { useLayoutEffect, useRef } from "react";
import { effectMoveEasing, playEffect } from "@meltiply/ui/effects";
import { cn } from "@meltiply/ui/utils";

/** How long one count roll takes, in milliseconds. */
const ROLL_MS = 180;

export interface RollingCountProps {
  /** The count to show. A change rolls the previous value out and the new one in. */
  value: number;
  /** Layout classes for the one-line window, e.g. type or colour. */
  className?: string;
}

/**
 * A count that rolls when it changes, shared by every surface that shows one — the
 * Posts grid's column stepper, Channels' tab counts, a Post's channel and
 * attachment totals, a table group's size.
 *
 * The window is one line tall and clips (`data-value-roll` in `motion.css`), so a
 * change reads as a drum turning: the new value arrives from the side the count
 * moved from while the previous one leaves the other way, and the value stays one
 * reading of the number for assistive technology. Both halves are one shared WAAPI
 * effect on `translate` and `opacity` only.
 *
 * The previous value is a clone this owner appends and removes when its effect
 * ends, which keeps the change out of React's state: nothing re-renders the
 * surrounding list to play it, and a count that is merely mounted never rolls.
 *
 * @param props.value - The count to display.
 * @param props.className - Layout classes for the window.
 * @returns An inline one-line window holding the current count.
 */
export function RollingCount({ value, className }: RollingCountProps) {
  const windowRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(value);
  const isMountedRef = useRef(false);

  useLayoutEffect(() => {
    const window = windowRef.current;
    const entering = window?.firstElementChild;
    if (!window || !(entering instanceof HTMLElement)) return;

    if (!isMountedRef.current) {
      // The first value is simply painted where it stands.
      isMountedRef.current = true;
      shownRef.current = value;
      return;
    }

    const previous = shownRef.current;
    if (previous === value) return;
    shownRef.current = value;

    // A grown count rolls up, a shrunk one rolls down: the arriving value comes
    // from the side the count moved from and the previous leaves the other way.
    const travel = value > previous ? 1 : -1;
    playEffect(
      entering,
      [
        { transform: `translateY(${travel * 100}%)`, opacity: 0 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      0,
      { duration: ROLL_MS, easing: effectMoveEasing },
    );

    const leaving = document.createElement("span");
    leaving.dataset.valueRoll = "out";
    leaving.setAttribute("aria-hidden", "true");
    leaving.textContent = String(previous);
    window.appendChild(leaving);

    const effect = playEffect(
      leaving,
      [
        { transform: "translateY(0)", opacity: 1 },
        { transform: `translateY(${travel * -100}%)`, opacity: 0 },
      ],
      0,
      { duration: ROLL_MS, easing: effectMoveEasing, fill: "forwards" },
    );
    const removeLeaving = () => leaving.remove();
    if (effect) effect.finished.then(removeLeaving, removeLeaving);
    else removeLeaving();

    return () => leaving.remove();
  }, [value]);

  return (
    <span ref={windowRef} data-value-roll className={cn(className)}>
      <span data-value-roll="in">{value}</span>
    </span>
  );
}
