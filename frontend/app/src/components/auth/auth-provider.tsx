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
import { WorkspaceLoadingSkeleton } from "@/components/layout/workspace-loading-skeleton";

export interface MeltiplyAuthContextValue {
  brandProfileId: string | null;
  cacheScope: string;
  isLoaded: boolean;
  isSignedIn: boolean;
  refreshSession: () => Promise<void>;
  setBrandProfileId: (brandProfileId: string | null) => void;
  setWorkspaceId: (workspaceId: string | null) => void;
  signOut: () => Promise<void>;
  user: AuthUser | null;
  workspaceId: string | null;
}

const MeltiplyAuthContext = createContext<MeltiplyAuthContextValue | null>(null);

export function AppAuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(null);
  const [brandProfileId, setBrandProfileId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const userIdRef = useRef<string | null>(null);
  const latestSessionRead = useRef(0);

  const clearSession = useCallback(() => {
    userIdRef.current = null;
    setUser(null);
    setWorkspaceIdState(null);
    setBrandProfileId(null);
  }, []);

  const resolveSession = useCallback(async () => {
    const read = ++latestSessionRead.current;
    try {
      const result = await authClient.getSession();
      if (read !== latestSessionRead.current) return;
      const nextUser = result?.user ?? null;
      if ((nextUser?.id ?? null) !== userIdRef.current) {
        userIdRef.current = nextUser?.id ?? null;
        setWorkspaceIdState(null);
        setBrandProfileId(null);
      }
      setUser(nextUser);
    } catch {
      if (read === latestSessionRead.current) clearSession();
    } finally {
      if (read === latestSessionRead.current) setIsLoaded(true);
    }
  }, [clearSession]);

  const handleSignOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      latestSessionRead.current += 1;
      clearSession();
      setIsLoaded(true);
    }
  }, [clearSession]);

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

export function useMeltiplyAuth(): MeltiplyAuthContextValue {
  const context = useContext(MeltiplyAuthContext);
  if (!context) {
    throw new Error("Meltiply authentication provider is unavailable.");
  }
  return context;
}

export function RequireAuth({ children }: { children: React.ReactNode }): React.ReactElement {
  const { isLoaded, isSignedIn } = useMeltiplyAuth();
  if (!isLoaded) {
    return <WorkspaceLoadingSkeleton />;
  }
  return isSignedIn ? <>{children}</> : <Navigate to="/sign-in" replace />;
}
