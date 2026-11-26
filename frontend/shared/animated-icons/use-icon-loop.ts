import { useEffect, useRef } from "react";
import { useAnimation } from "motion/react";

import { useReducedMotionPreference } from "../src/components/primitives/use-reduced-motion";

export function useIconLoop(active: boolean, restMs: number = 2000) {
  const controls = useAnimation();
  const prefersReducedMotion = useReducedMotionPreference();

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

    if (prefersReducedMotion) {
      runningRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      controls.start("normal").catch(() => {});
      return;
    }

    if (!active && timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      runningRef.current = false;
    }

    if (active && !runningRef.current) {
      runningRef.current = true;
      const generation = generationRef.current;
      const isCurrent = () => generationRef.current === generation && isMountedRef.current;

      const runCycle = () => {
        if (!isCurrent()) return;
        if (!activeRef.current) {
          controls.start("normal").catch(() => {});
          runningRef.current = false;
          return;
        }

        controls
          .start("animate")
          .then(() => {
            if (!isCurrent()) return;
            return controls.start("normal");
          })
          .then(() => {
            if (!isCurrent()) return;
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
            if (isCurrent()) runningRef.current = false;
          });
      };

      runCycle();
    }
  }, [active, controls, prefersReducedMotion, restMs]);

  return controls;
}
