import { useLayoutEffect, useSyncExternalStore } from "react";
import { motionAllowed, readSystemLowMotion, reducedMotionQuery } from "./motion-state";

const subscribers = new Set<() => void>();
let stopObservation: (() => void) | undefined;

/** Publishes root/OS changes to all React islands sharing the native motion policy. */
function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber();
}

/** Shares one root observer and OS listener; the last consumer releases both. */
function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) {
    const observer = new MutationObserver(notifySubscribers);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-low-motion", "data-theme-ink"],
    });
    let query: MediaQueryList | undefined;
    try {
      query = window.matchMedia(reducedMotionQuery);
      query.addEventListener("change", notifySubscribers);
    } catch {
      // Root policy remains authoritative when media queries are unavailable.
    }
    stopObservation = () => {
      observer.disconnect();
      query?.removeEventListener("change", notifySubscribers);
    };
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      stopObservation?.();
      stopObservation = undefined;
    }
  };
}

/** Reads the actual effective policy; OS accessibility is always authoritative. */
function readLowMotion(): boolean {
  return document.documentElement.hasAttribute("data-low-motion") || readSystemLowMotion();
}

/** Keeps server-rendered geometry at rest before a browser policy is available. */
function serverSnapshot(): boolean {
  return true;
}

/**
 * Applies Meltiply's reduced-motion presentation policy to the application root.
 * This is a policy boundary, not a user preference: it exposes no inert setter,
 * invented OS state, optional storage, or manual toggle. Native pages apply the
 * same root flag before paint through MotionBootstrap.
 */
export function MotionPreferenceProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-low-motion", "");
  }, []);
  return children;
}

/** Observes effective motion policy across React and native Astro islands. */
export function useMotionPreference(): { lowMotion: boolean } {
  return { lowMotion: useSyncExternalStore(subscribe, readLowMotion, serverSnapshot) };
}

/** Observes whether spatial effects are permitted by the current root/OS policy. */
export function useMotionAllowed(): boolean {
  return useSyncExternalStore(subscribe, motionAllowed, () => false);
}
