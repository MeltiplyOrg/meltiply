import React, { createContext, useContext } from "react";

import { useSessionScope } from "@/hooks/use-session-scope";
import { usePublishingPreferences } from "@/lib/queries";

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PublishingTimeZoneContext = createContext<string>(browserTimeZone);

/**
 * Supplies the owner's persistent publishing timezone to every scheduling and
 * date-display surface, falling back to the browser zone when no preference is
 * saved. The provider mounts inside the authenticated workspace, while the
 * context default keeps isolated component tests renderable without an auth or
 * query provider.
 */
export function PublishingTimeZoneProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const scope = useSessionScope();
  const preferences = usePublishingPreferences(scope, scope.isSignedIn);
  return (
    <PublishingTimeZoneContext.Provider value={preferences.data?.timezone ?? browserTimeZone}>
      {children}
    </PublishingTimeZoneContext.Provider>
  );
}

/**
 * Reads the active publishing timezone. Components outside the provider (for
 * example a focused unit test) receive the browser's resolved zone.
 */
export function usePublishingTimeZone(): string {
  return useContext(PublishingTimeZoneContext);
}
