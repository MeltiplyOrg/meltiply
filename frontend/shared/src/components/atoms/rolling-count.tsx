import { useLayoutEffect, useRef } from "react";
import { effectMoveEasing, playEffect } from "@meltiply/ui/effects";
import { cn } from "@meltiply/ui/utils";

const ROLL_MS = 180;

export interface RollingCountProps {
  value: number;
  className?: string;
}

export function RollingCount({ value, className }: RollingCountProps) {
  const windowRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(value);
  const isMountedRef = useRef(false);

  useLayoutEffect(() => {
    const window = windowRef.current;
    const entering = window?.firstElementChild;
    if (!window || !(entering instanceof HTMLElement)) return;

    if (!isMountedRef.current) {
      isMountedRef.current = true;
      shownRef.current = value;
      return;
    }

    const previous = shownRef.current;
    if (previous === value) return;
    shownRef.current = value;

    const travel = value > previous ? 1 : -1;
    const leaving = document.createElement("span");
    leaving.dataset.valueRoll = "out";
    leaving.setAttribute("aria-hidden", "true");
    leaving.textContent = String(previous);
    window.appendChild(leaving);
    window.dataset.rollState = "pending";

    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        delete window.dataset.rollState;
        playEffect(
          entering,
          [
            { transform: `translateY(${travel * 100}%)`, opacity: 0 },
            { transform: "translateY(0)", opacity: 1 },
          ],
          0,
          { duration: ROLL_MS, easing: effectMoveEasing },
        );

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
      });
    });

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      delete window.dataset.rollState;
      leaving.remove();
    };
  }, [value]);

  return (
    <span ref={windowRef} data-value-roll className={cn(className)}>
      <span data-value-roll="in">{value}</span>
    </span>
  );
}
