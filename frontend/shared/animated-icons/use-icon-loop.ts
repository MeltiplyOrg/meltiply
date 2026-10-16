import { useEffect, useRef } from "react";
import { useAnimation } from "motion/react";

import { useMotionPreference, useMotionAllowed } from "../motion-preference";

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
 *    a cycle is cancelled (low motion, ink freeze, or unmount), so stale resolutions can never restart an old loop.
 *    Teardown resets idle flags so StrictMode's effect replay can restart an initially active icon.
 * 5. **Low Motion**: When {@link useMotionPreference} reports effective low motion (manual toggle or OS
 *    `prefers-reduced-motion`, including a live OS change), any running cycle is stopped, the icon snaps back to
 *    `normal`, the rest timer is cancelled, and no new cycle starts — hover input is ignored until motion resumes.
 * 6. **Ink Freeze**: While {@link useMotionAllowed} reports `false` only because the shared theme-ink snapshot is
 *    capturing (`data-theme-ink` without low motion), in-flight cycles are stopped *in place* — the icon keeps its
 *    current pose so the ink clone matches the live source — and loops resume from hover state once ink clears.
 *    Provider-free landing islands observe the same root attributes via the shared subscription.
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
  const { lowMotion } = useMotionPreference();
  const allowed = useMotionAllowed();
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
    // Low motion suppresses hover loops entirely: stop any in-flight cycle, snap the
    // icon back to `normal`, and cancel the rest timer so no timers keep running.
    if (lowMotion) {
      activeRef.current = false;
      runningRef.current = false;
      generationRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      controls.stop();
      controls.set("normal");
      return;
    }

    // During ink capture, freeze the current pose without resetting to `normal` so the
    // cloned snapshot stays pixel-aligned; cycles resume from the persisted hover state.
    if (!allowed) {
      runningRef.current = false;
      generationRef.current += 1;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      controls.stop();
      return;
    }

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
      // a stale chain (cancelled by low motion, ink, or unmount) must not resurrect itself.
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
  }, [active, controls, lowMotion, allowed, restMs]);

  return controls;
}
