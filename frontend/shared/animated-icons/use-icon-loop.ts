import { useEffect, useRef } from "react";
import { useAnimation } from "motion/react";

/**
 * Manages looping motion animation sequences for interactive SVG icons.
 *
 * Orchestrates motion playback with a guaranteed full-cycle execution contract:
 * 1. **Complete Execution**: On hover trigger (`active = true`), plays the complete animation sequence
 *    from start (`animate`) back to resting state (`normal`), even if the user cursor briefly flicks over the icon.
 * 2. **Looping with Rest Interval**: If hover is sustained after completing a cycle, rests at `normal` for `restMs`
 *    (default: 2000ms) before initiating the next playback loop.
 * 3. **Cancellation & Settle**: If unhovered during playback, the current cycle finishes completely and settles at
 *    `normal` without starting a subsequent loop. If unhovered while resting during the `restMs` window, the scheduled
 *    timeout is cancelled immediately and the runner is marked idle.
 * 4. **Safety & Teardown**: Component unmounting clears pending timeouts and suppresses downstream animation promises
 *    via ref-tracked mount state. A generation stamp invalidates in-flight `controls.start()` promise chains whenever
 *    the owner unmounts, so stale resolutions cannot restart an old loop.
 *    Teardown resets idle flags so StrictMode's effect replay can restart an initially active icon.
 *
 * @param active - Boolean indicating whether hover/active state is engaged (either internally or via external props).
 * @param restMs - Rest duration in milliseconds spent at rest between successive animation cycles while hovered (default: 2000ms).
 * @returns `AnimationControls` instance from `motion/react` bound to the icon's motion variants (`animate` and `normal`).
 *
 * @example
 * ```tsx
 * const controls = useIconLoop(isHovered, 2000);
 * return <motion.svg animate={controls} variants={...} />;
 * ```
 */
export function useIconLoop(active: boolean, restMs: number = 2000) {
  const controls = useAnimation();

  const activeRef = useRef(active);
  const runningRef = useRef(false);
  const isMountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeRef.current = false;
      runningRef.current = false;
      generationRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;

    // If hover ends while resting, cancel rest timer immediately
    if (!active && timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      runningRef.current = false;
    }

    if (active && !runningRef.current) {
      runningRef.current = true;
      const generation = generationRef.current;
      // Only the generation that launched this chain may settle flags or schedule loops;
      // a stale chain from an unmounted owner must not restart.
      const isCurrent = () => generationRef.current === generation && isMountedRef.current;

      const runCycle = () => {
        if (!isCurrent()) return;
        if (!activeRef.current) {
          controls.start("normal").catch(() => {});
          runningRef.current = false;
          return;
        }

        // 1. Play the full cycle
        controls
          .start("animate")
          .then(() => {
            if (!isCurrent()) return;
            return controls.start("normal");
          })
          .then(() => {
            if (!isCurrent()) return;
            // 2. If still hovered, rest for restMs (2s) before next loop
            if (activeRef.current && restMs > 0) {
              timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                runCycle();
              }, restMs);
            } else if (activeRef.current) {
              runCycle();
            } else {
              runningRef.current = false;
            }
          })
          .catch(() => {
            // `controls.stop()` rejects the pending chain; only settle when still current.
            if (isCurrent()) runningRef.current = false;
          });
      };

      runCycle();
    }
  }, [active, controls, restMs]);

  return controls;
}
