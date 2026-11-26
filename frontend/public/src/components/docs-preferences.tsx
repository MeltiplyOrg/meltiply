import { useContext, useSyncExternalStore, type ReactElement } from "react";
import { ThemeIcon } from "@meltiply/ui/preference-icons";
import { DocsThemeContext, DocsThemeProvider } from "./docs-theme";
import { DocumentationSearchTrigger } from "./search";

function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

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

export function LandingPreferences(): ReactElement {
  return (
    <DocsThemeProvider>
      <DocsPreferences />
    </DocsThemeProvider>
  );
}
