import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useMeltiplyAuth } from "@/components/auth/auth-provider";
import { RuntimeStatus } from "@/components/layout/runtime-status";
import { ApiError } from "@/lib/api";
import { isDevMode } from "@/lib/env";
import { userFacingErrorMessage } from "@/lib/frontend-errors";
import { reportFrontendError } from "@/lib/frontend-telemetry";
import { privateCacheRetentionMs, queryRetryDelay, shouldRetryQuery } from "@/lib/query-defaults";
import {
  authRefreshRequestEvent,
  dispatchRuntimeStatus,
  type RuntimeStatusDetail,
} from "@/lib/runtime-events";

// Dev-only: bridges the workspace-scoped QueryClient to the root-mounted
// DevBox dock. The lazy boundary keeps the devbox module out of production
// bundles entirely.
const DevBoxClientBridge = isDevMode()
  ? lazy(async () => {
      const { DevBoxClientBridge } = await import("@/components/devbox/dev-box");
      return { default: DevBoxClientBridge };
    })
  : null;

type AppProvidersProps = {
  children: React.ReactNode;
};

/**
 * Classifies query transport failures that never produced an HTTP response (e.g. network disconnection,
 * DNS failure, or CORS block) into appropriate user-facing runtime status banners.
 *
 * @param error Caught rejection cause (typically a browser `TypeError` from `fetch`).
 * @param isOnline Current browser online status boolean from `navigator.onLine`.
 * @returns Formatted runtime status detail object indicating offline or recoverable failure.
 */
export function transportStatus(error: unknown, isOnline: boolean): RuntimeStatusDetail {
  if (!(error instanceof TypeError)) {
    return {
      kind: "recoverable",
      message: "We could not refresh this view. Try again in a moment.",
    };
  }
  return isOnline
    ? {
        kind: "recoverable",
        message: "Meltiply could not reach the API. Check your connection and try again.",
      }
    : { kind: "offline", message: "Changes are paused until your connection returns." };
}

/**
 * Global QueryCache error callback that reports telemetry, requests a bearer-token
 * refresh on 401s, and surfaces workspace, maintenance, or recoverable network
 * banners via runtime events.
 *
 * @param error Error thrown or rejected by a TanStack Query fetcher.
 */
function reportQueryError(error: unknown): void {
  reportFrontendError(error, "query-cache");
  if (!(error instanceof ApiError)) {
    dispatchRuntimeStatus(transportStatus(error, navigator.onLine));
    return;
  }

  if (error.status === 401) {
    window.dispatchEvent(new CustomEvent(authRefreshRequestEvent, { detail: error }));
    return;
  }
  if (error.code === "active_organization_required") {
    dispatchRuntimeStatus({
      kind: "active-organization",
      message: userFacingErrorMessage(error),
    });
    return;
  }
  if (error.status === 503) {
    dispatchRuntimeStatus({
      kind: "maintenance",
      message: userFacingErrorMessage(error),
    });
    return;
  }
  if (error.retryable) {
    dispatchRuntimeStatus({
      kind: "recoverable",
      message: userFacingErrorMessage(error),
    });
  }
}

/**
 * Headless bridge component that listens for 401 API errors, renews the in-memory
 * bearer JWT via `refreshSession` (re-minted through the Better Auth lifecycle
 * endpoints, the only cookie-authenticated calls), and invalidates active queries
 * upon success, preventing unauthenticated loops. A failed or expired session
 * surfaces the sign-in-again banner — either immediately when the refresh rejects,
 * or through the throttled re-request path when the retried query 401s again.
 *
 * @returns `null` as a headless lifecycle bridge.
 */
function AuthRefreshBridge(): null {
  const { refreshSession } = useMeltiplyAuth();
  const queryClient = useQueryClient();
  const inFlight = useRef<Promise<void> | null>(null);
  const lastAttemptAt = useRef(0);

  useEffect(() => {
    const onRefreshRequest = (event: Event) => {
      const error = (event as CustomEvent<ApiError>).detail;
      if (inFlight.current) return;
      if (Date.now() - lastAttemptAt.current < 10_000) {
        dispatchRuntimeStatus({
          kind: "auth-expired",
          message: "Sign in again to continue.",
        });
        reportFrontendError(error, "auth-refresh-throttled");
        return;
      }

      lastAttemptAt.current = Date.now();
      inFlight.current = (async () => {
        try {
          await refreshSession();
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          await queryClient.invalidateQueries({ type: "active" });
          dispatchRuntimeStatus(null);
        } catch (refreshError) {
          reportFrontendError(refreshError, "auth-refresh");
          dispatchRuntimeStatus({
            kind: "auth-expired",
            message: "Sign in again to continue.",
          });
        } finally {
          inFlight.current = null;
        }
      })();
    };

    window.addEventListener(authRefreshRequestEvent, onRefreshRequest);
    return () => window.removeEventListener(authRefreshRequestEvent, onRefreshRequest);
  }, [refreshSession, queryClient]);

  return null;
}

/**
 * Scoped provider container managing an isolated TanStack `QueryClient` instance, query cache error
 * listeners, and runtime status UI banners for the current workspace.
 *
 * @param props Component children to render within the query scope.
 * @returns React element rendering provider wrappers.
 */
function ScopedAppProviders({ children }: AppProvidersProps): React.ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: reportQueryError,
          onSuccess: () => {
            if (navigator.onLine) dispatchRuntimeStatus(null);
          },
        }),
        defaultOptions: {
          mutations: { retry: false },
          queries: {
            refetchOnReconnect: true,
            refetchOnWindowFocus: true,
            retry: shouldRetryQuery,
            retryDelay: queryRetryDelay,
            staleTime: 60 * 1000,
            gcTime: privateCacheRetentionMs,
          },
        },
      }),
  );

  // A replaced identity/Workspace must release private data and cancel its
  // in-flight reads, not merely leave the old QueryClient to a GC timer.
  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthRefreshBridge />
      <RuntimeStatus />
      {DevBoxClientBridge && (
        <Suspense fallback={null}>
          <DevBoxClientBridge />
        </Suspense>
      )}
      {children}
    </QueryClientProvider>
  );
}

/**
 * Top-level application provider wrapper that isolates the query cache per workspace boundary.
 *
 * Keys `ScopedAppProviders` by `cacheScope` (user + selected workspace) so that switching
 * workspaces destroys the previous cache completely and prevents cross-tenant data leaks.
 *
 * @param props Component children to render.
 * @returns React element wrapping children in scoped providers.
 */
export function AppProviders({ children }: AppProvidersProps): React.ReactElement {
  const { cacheScope } = useMeltiplyAuth();
  return <ScopedAppProviders key={cacheScope}>{children}</ScopedAppProviders>;
}
