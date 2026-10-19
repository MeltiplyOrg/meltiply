import { useContext, useSyncExternalStore, type ReactElement } from "react";
import { ThemeIcon } from "@meltiply/ui/preference-icons";
import { DocsThemeContext, DocsThemeProvider } from "./docs-theme";
import { DocumentationSearchTrigger } from "./search";

/** Keeps preference labels server-neutral until the browser palette is available. */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * Public theme control backed by the shared consent-aware theme owner.
 * There is no app motion mode; native OS accessibility is handled by effects.
 * Optional article search stays bound to Fumadocs' existing search context.
 */
export function DocsPreferences({
  includeSearch = false,
}: {
  includeSearch?: boolean;
}): ReactElement {
  const mounted = useMounted();
  const controller = useContext(DocsThemeContext);
  if (controller === null) throw new Error("DocsPreferences requires DocsThemeProvider");
  const { requestedTheme, resolvedTheme, toggleTheme } = controller;
  const dark = mounted && (requestedTheme ?? resolvedTheme) === "dark";
  const action = mounted ? `Switch to ${dark ? "light" : "dark"} theme` : "Switch theme";
  return (
    <div className="docs-prefs">
      {includeSearch && <DocumentationSearchTrigger />}
      <button
        type="button"
        className="docs-pref-button"
        aria-label={action}
        title={action}
        onClick={toggleTheme}
      >
        <ThemeIcon className="docs-pref-button-icon" />
      </button>
    </div>
  );
}

/** Shares the docs theme controller on the static landing page without a second preference owner. */
export function LandingPreferences(): ReactElement {
  return (
    <DocsThemeProvider>
      <DocsPreferences />
    </DocsThemeProvider>
  );
}
