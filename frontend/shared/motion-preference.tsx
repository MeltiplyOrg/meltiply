import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import {
  motionAllowed,
  readStoredManualLowMotion,
  readSystemLowMotion,
  reducedMotionQuery,
  writeStoredManualLowMotion,
} from "./motion-state";
import { hasCookieConsent, subscribeCookieConsent } from "./cookie-consent";

interface MotionPreferenceContextValue {
  /** Effective low-motion state: manual choice OR operating-system reduced motion. */
  lowMotion: boolean;
  /** Provider-owned manual choice; native observers expose persisted manual metadata only. */
  manualLowMotion: boolean;
  /** Whether the operating system currently requests reduced motion. */
  systemLowMotion: boolean;
  /** Requires the provider; updates its manual choice even when persistence is denied. */
  setManualLowMotion: (enabled: boolean) => void;
}

const MotionPreferenceContext = createContext<MotionPreferenceContextValue | null>(null);
const rootMotionSubscribers = new Set<() => void>();
let stopRootObservation: (() => void) | undefined;

/** Notifies subscribed React islands; stable boolean snapshots suppress unrelated preference renders. */
function notifyRootMotionSubscribers(): void {
  for (const subscriber of rootMotionSubscribers) subscriber();
}

/**
 * Shares one root observer and OS listener across provider-free Astro islands.
 * The last unsubscribe tears both down; ink flags also notify spatial-motion hooks.
 */
function subscribeRootMotion(subscriber: () => void): () => void {
  rootMotionSubscribers.add(subscriber);
  if (rootMotionSubscribers.size === 1) {
    const observer = new MutationObserver(notifyRootMotionSubscribers);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-low-motion", "data-theme-ink"],
    });
    let mediaQuery: MediaQueryList | undefined;
    try {
      mediaQuery = window.matchMedia(reducedMotionQuery);
      mediaQuery.addEventListener("change", notifyRootMotionSubscribers);
    } catch {
      // Root attributes remain observable when media queries are unavailable.
    }
    stopRootObservation = () => {
      observer.disconnect();
      mediaQuery?.removeEventListener("change", notifyRootMotionSubscribers);
    };
  }
  return () => {
    rootMotionSubscribers.delete(subscriber);
    if (rootMotionSubscribers.size === 0) {
      stopRootObservation?.();
      stopRootObservation = undefined;
    }
  };
}

/** Reads effective native-page low motion; OS reduction wins even before its root attribute is mirrored. */
function readRootLowMotion(): boolean {
  return (
    (typeof document !== "undefined" && document.documentElement.hasAttribute("data-low-motion")) ||
    readSystemLowMotion()
  );
}

/** Tracks each preference input, so OS/manual changes rerender even when effective low motion stays on. */
function readRootPreferenceSnapshot(): number {
  const systemLowMotion = readSystemLowMotion();
  const lowMotion =
    (typeof document !== "undefined" && document.documentElement.hasAttribute("data-low-motion")) ||
    systemLowMotion;
  return (
    Number(lowMotion) | (Number(systemLowMotion) << 1) | (Number(readStoredManualLowMotion()) << 2)
  );
}

/** Supplies a stable, unselected SSR preference snapshot without reading browser state. */
function serverPreferenceSnapshot(): number {
  return 0;
}

/** Keeps SSR icon geometry at rest; hydration reads the actual browser preference before interaction. */
function serverMotionSnapshot(): boolean {
  return false;
}

/** Native islands observe preferences; only a React provider may mutate its owned manual state. */
function setUnwrappedManualLowMotion(): void {
  throw new Error("Manual motion controls require MotionPreferenceProvider");
}

/** Provider-free readers observe root/OS state and persisted metadata; their native page adapter owns manual controls. */
const unwrappedPreference: MotionPreferenceContextValue = {
  get lowMotion() {
    return readRootLowMotion();
  },
  get manualLowMotion() {
    return readStoredManualLowMotion();
  },
  get systemLowMotion() {
    return readSystemLowMotion();
  },
  setManualLowMotion: setUnwrappedManualLowMotion,
};

/**
 * Resolves the app's manual OR OS motion preference and publishes it to CSS.
 * Storage denial preserves current-page choices; consent withdrawal drops the
 * old manual override while OS accessibility settings remain authoritative.
 * Native landing islands consume the same module without mounting a provider,
 * reacting to their page adapter's root flags instead of duplicating its state.
 *
 * @param props Component props containing child elements.
 * @returns Context provider element.
 */
export function MotionPreferenceProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [manualLowMotion, setManualLowMotionState] = useState(readStoredManualLowMotion);
  const [systemLowMotion, setSystemLowMotion] = useState(readSystemLowMotion);
  const lowMotion = manualLowMotion || systemLowMotion;

  // A revoked persisted override must not survive a sibling-site withdrawal.
  // Unrelated consent edits leave current-page, nonpersisted controls alone.
  useEffect(() => {
    let previouslyAllowed = hasCookieConsent("functional");
    return subscribeCookieConsent(() => {
      const allowed = hasCookieConsent("functional");
      if (previouslyAllowed && !allowed) setManualLowMotionState(false);
      previouslyAllowed = allowed;
    });
  }, []);

  useEffect(() => {
    let mediaQuery: MediaQueryList;
    try {
      mediaQuery = window.matchMedia(reducedMotionQuery);
    } catch {
      return;
    }

    const updateSystemPreference = () => setSystemLowMotion(mediaQuery.matches);
    updateSystemPreference();
    mediaQuery.addEventListener("change", updateSystemPreference);
    return () => mediaQuery.removeEventListener("change", updateSystemPreference);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-low-motion", lowMotion);
  }, [lowMotion]);

  const setManualLowMotion = useCallback((enabled: boolean) => {
    setManualLowMotionState(enabled);
    writeStoredManualLowMotion(enabled);
  }, []);

  const value = useMemo<MotionPreferenceContextValue>(
    () => ({ lowMotion, manualLowMotion, setManualLowMotion, systemLowMotion }),
    [lowMotion, manualLowMotion, setManualLowMotion, systemLowMotion],
  );

  return <MotionPreferenceContext value={value}>{children}</MotionPreferenceContext>;
}

/**
 * Reads app context or subscribes a native-page React island to shared root/OS
 * preferences. All islands reuse one observer, so manual changes cancel live
 * icon motion without a separate provider or per-icon DOM observer.
 * Manual mutations require the provider; native controls use their page adapter
 * so a decorative island cannot introduce a competing preference state owner.
 */
export function useMotionPreference(): MotionPreferenceContextValue {
  const context = useContext(MotionPreferenceContext);
  useSyncExternalStore(subscribeRootMotion, readRootPreferenceSnapshot, serverPreferenceSnapshot);
  return context ?? unwrappedPreference;
}

/** Reactively gates spatial effects during ink capture as well as manual/OS low motion; SSR stays at rest. */
export function useMotionAllowed(): boolean {
  return useSyncExternalStore(subscribeRootMotion, motionAllowed, serverMotionSnapshot);
}
