import React, { createContext, useContext } from "react";

import { useSessionScope } from "@/hooks/use-session-scope";
import { usePublishingPreferences } from "@/lib/queries";

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PublishingTimeZoneContext = createContext<string>(browserTimeZone);

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

export function usePublishingTimeZone(): string {
  return useContext(PublishingTimeZoneContext);
}
