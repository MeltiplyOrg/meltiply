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

const DevBoxClientBridge = isDevMode()
  ? lazy(async () => {
      const { DevBoxClientBridge } = await import("@/components/devbox/dev-box");
      return { default: DevBoxClientBridge };
    })
  : null;

type AppProvidersProps = {
  children: React.ReactNode;
};

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

export function reportQueryError(error: unknown): void {
  if (!(error instanceof ApiError)) {
    reportFrontendError(error, "query-cache");
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

export function AppProviders({ children }: AppProvidersProps): React.ReactElement {
  const { cacheScope } = useMeltiplyAuth();
  return <ScopedAppProviders key={cacheScope}>{children}</ScopedAppProviders>;
}
