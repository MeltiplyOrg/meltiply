import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Navigate } from "react-router";

import { authClient, type AuthUser } from "@/lib/auth-client";
import { authSessionRefreshedEvent } from "@/lib/runtime-events";
import { useI18n } from "@/lib/i18n";

export interface MeltiplyAuthContextValue {
  /** Active Brand Profile selection; `null` is the aggregate "All Brand Profiles" view. */
  brandProfileId: string | null;
  cacheScope: string;
  isLoaded: boolean;
  isSignedIn: boolean;
  refreshSession: () => Promise<void>;
  /** Selects the active Brand Profile; `null` returns to the aggregate view. */
  setBrandProfileId: (brandProfileId: string | null) => void;
  /** Selects the active Workspace and resets the Brand Profile selection to aggregate. */
  setWorkspaceId: (workspaceId: string | null) => void;
  signOut: () => Promise<void>;
  user: AuthUser | null;
  workspaceId: string | null;
}

const MeltiplyAuthContext = createContext<MeltiplyAuthContextValue | null>(null);

/**
 * Top-level application authentication provider for Better Auth.
 * Resolves the session through the Better Auth lifecycle endpoints — the only
 * requests that still send the HttpOnly session cookie — which mint or renew
 * the in-memory bearer JWT forwarded on `/api/v1` calls. Refreshes on a
 * background interval and on visibility/session-change events, isolates the
 * query cache per user and workspace scope, and coordinates sign-out. The
 * bearer token is never exposed: the context surfaces only identity,
 * workspace selection, and lifecycle actions.
 *
 * @param props.children - Child components requiring authentication capabilities.
 * @returns React element rendering context provider with session capabilities.
 */
export function AppAuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(null);
  const [brandProfileId, setBrandProfileId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const userIdRef = useRef<string | null>(null);

  const resolveSession = useCallback(async () => {
    try {
      const result = await authClient.getSession();
      const nextUser = result?.user ?? null;
      // Workspace and Brand Profile selections are user-scoped state: when the
      // session resolves to a different user (or signed out), reset both so a
      // stale selection never leaks into another user's requests.
      if (nextUser?.id !== userIdRef.current) {
        userIdRef.current = nextUser?.id ?? null;
        setWorkspaceIdState(null);
        setBrandProfileId(null);
      }
      setUser(nextUser);
    } catch {
      userIdRef.current = null;
      setUser(null);
      setWorkspaceIdState(null);
      setBrandProfileId(null);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      userIdRef.current = null;
      setUser(null);
      setWorkspaceIdState(null);
      setBrandProfileId(null);
    }
  }, []);

  // Brand Profiles are workspace-owned: switching workspaces clears the
  // selection so a profile ID from the previous workspace is never sent.
  const setWorkspaceId = useCallback((nextWorkspaceId: string | null) => {
    setWorkspaceIdState(nextWorkspaceId);
    setBrandProfileId(null);
  }, []);

  useEffect(() => {
    let active = true;

    queueMicrotask(() => {
      if (active) void resolveSession();
    });

    const onSessionRefreshed = () => {
      if (active) void resolveSession();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && active) {
        void resolveSession();
      }
    };

    const refreshInterval = window.setInterval(
      () => {
        if (active) void resolveSession();
      },
      4 * 60 * 1000,
    );

    window.addEventListener(authSessionRefreshedEvent, onSessionRefreshed);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      window.removeEventListener(authSessionRefreshedEvent, onSessionRefreshed);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [resolveSession]);

  const cacheScope = useMemo(
    () => JSON.stringify([user?.id ?? null, workspaceId ?? null]),
    [user?.id, workspaceId],
  );

  const value = useMemo<MeltiplyAuthContextValue>(
    () => ({
      brandProfileId,
      cacheScope,
      isLoaded,
      isSignedIn: user !== null,
      refreshSession: resolveSession,
      setBrandProfileId,
      setWorkspaceId,
      signOut: handleSignOut,
      user,
      workspaceId,
    }),
    [
      brandProfileId,
      cacheScope,
      handleSignOut,
      isLoaded,
      resolveSession,
      setWorkspaceId,
      user,
      workspaceId,
    ],
  );

  return <MeltiplyAuthContext.Provider value={value}>{children}</MeltiplyAuthContext.Provider>;
}

/**
 * Hook to consume Meltiply's workspace-aware authentication context.
 * Provides the session user, workspace selection, a session refresh action, and
 * loading/sign-in status. Throws an error if invoked outside of `AppAuthProvider`.
 *
 * @returns The active MeltiplyAuthContextValue containing session state and actions.
 */
export function useMeltiplyAuth(): MeltiplyAuthContextValue {
  const context = useContext(MeltiplyAuthContext);
  if (!context) {
    throw new Error("Meltiply authentication provider is unavailable.");
  }
  return context;
}

/**
 * Route protection wrapper requiring an authenticated session before rendering children.
 * Displays a localized loading notice while session resolution is in progress, and automatically
 * redirects unauthenticated callers to `/sign-in`.
 *
 * @param props.children - Protected elements rendered only when signed in.
 * @returns The child tree if authenticated, a loading message, or a redirect Navigate element.
 */
export function RequireAuth({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isLoaded, isSignedIn } = useMeltiplyAuth();
  const { t } = useI18n();
  if (!isLoaded) {
    return <p className="p-6 text-[11px] font-medium text-ink-2">{t("Loading account…")}</p>;
  }
  return isSignedIn ? <>{children}</> : <Navigate to="/sign-in" replace />;
}
